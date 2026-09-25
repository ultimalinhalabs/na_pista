import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { DAY, TZ, at, bookBody, call, loadF27Fixtures, registerF27Credentials, seedBookable, setTimezone, startApp } from "./appointmentsHelpers.js";

/** F27 brief §57 — permissions (STAFF read-only), service credentials, entitlement, cross-tenant isolation, over real HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF27Fixtures();
const pathA = (suffix = "") => `/organizations/${fixtures.orgA.id}/appointments${suffix}`;

before(async () => {
  ctx = await startApp();
  registerF27Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, TZ);
  await setTimezone(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, TZ);
});
after(() => ctx.close());

// ---------------- permissions ----------------

test("STAFF: can list/get/see bookable slots, but create/reschedule/notes/cancel/complete are 403 FORBIDDEN", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Staff");
  const a = await call(ctx.base, "POST", pathA(), { token: fixtures.orgA.ownerToken, body: bookBody(seed, at("09:00")) });
  const staff = fixtures.staffA.token;

  assert.equal((await call(ctx.base, "GET", pathA(`?from=${DAY}&to=${DAY}`), { token: staff })).status, 200);
  assert.equal((await call(ctx.base, "GET", pathA(`/${a.data.id}`), { token: staff })).status, 200);
  assert.equal((await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${seed.professional.id}/bookable-slots?date=${DAY}&serviceId=${seed.service.id}`, { token: staff })).status, 200);

  const denied = [
    await call(ctx.base, "POST", pathA(), { token: staff, body: bookBody(seed, at("11:00")) }),
    await call(ctx.base, "PATCH", pathA(`/${a.data.id}`), { token: staff, body: { startAt: at("12:00") } }),
    await call(ctx.base, "PATCH", pathA(`/${a.data.id}`), { token: staff, body: { notes: "x" } }),
    await call(ctx.base, "POST", pathA(`/${a.data.id}/cancel`), { token: staff, body: {} }),
    await call(ctx.base, "POST", pathA(`/${a.data.id}/complete`), { token: staff }),
  ];
  for (const res of denied) {
    assert.equal(res.status, 403);
    assert.equal(res.error.code, "FORBIDDEN");
  }
  assert.equal((await call(ctx.base, "GET", pathA(`/${a.data.id}`), { token: staff })).data.status, "SCHEDULED", "nothing changed");
});

test("MANAGER: can create, reschedule, cancel (same rights as OWNER/ADMIN)", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Manager");
  const manager = fixtures.managerA.token;
  const a = await call(ctx.base, "POST", pathA(), { token: manager, body: bookBody(seed, at("09:00")) });
  assert.equal(a.status, 201);
  assert.equal((await call(ctx.base, "PATCH", pathA(`/${a.data.id}`), { token: manager, body: { startAt: at("10:00") } })).status, 200);
  assert.equal((await call(ctx.base, "POST", pathA(`/${a.data.id}/cancel`), { token: manager, body: {} })).status, 200);
});

test("service credential with catalog.write can book on its own org; one with only usage.write/event.publish is 403", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Credential");
  const ok = await call(ctx.base, "POST", pathA(), { token: fixtures.apiKeys.integrationA.secret, body: bookBody(seed, at("09:00")) });
  assert.equal(ok.status, 201);
  const insufficient = await call(ctx.base, "POST", pathA(), { token: fixtures.apiKeys.platformFacingA.secret, body: bookBody(seed, at("11:00")) });
  assert.equal(insufficient.status, 403);
});

test("no Authorization header -> 401", async () => {
  assert.equal((await call(ctx.base, "GET", pathA(`?from=${DAY}&to=${DAY}`))).status, 401);
});

// ---------------- entitlement ----------------

test("entitlement disabled (org C, no subscription): 503 without a credential, 403 ENTITLEMENT_REQUIRED with one — for reads and writes", async () => {
  const listPath = `/organizations/${fixtures.orgC.id}/appointments?from=${DAY}&to=${DAY}`;
  const noCredential = await call(ctx.base, "GET", listPath, { token: fixtures.orgC.ownerToken });
  assert.equal(noCredential.status, 503);

  const keyRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgC.id}/api-keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgC.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] }),
  });
  assert.equal(keyRes.status, 201);
  const { registerServiceCredential } = await import("../../src/platform/serviceAuth.js");
  registerServiceCredential(fixtures.orgC.id, (await keyRes.json()).data.secret);

  const read = await call(ctx.base, "GET", listPath, { token: fixtures.orgC.ownerToken });
  assert.equal(read.status, 403);
  assert.equal(read.error.code, "ENTITLEMENT_REQUIRED");
  const write = await call(ctx.base, "POST", `/organizations/${fixtures.orgC.id}/appointments`, {
    token: fixtures.orgC.ownerToken,
    body: { customerId: fixtures.orgC.id, professionalId: fixtures.orgC.id, serviceId: fixtures.orgC.id, startAt: at("09:00") },
  });
  assert.equal(write.status, 403);
  assert.equal(write.error.code, "ENTITLEMENT_REQUIRED");
});

test("entitlement enabled (org A, active subscription) permits appointment operations", async () => {
  assert.equal((await call(ctx.base, "GET", pathA(`?from=${DAY}&to=${DAY}`), { token: fixtures.orgA.ownerToken })).status, 200);
});

// ---------------- tenant isolation ----------------

test("org B's member cannot reach org A's appointments through org A's path (no membership -> 403)", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Iso Path");
  const a = await call(ctx.base, "POST", pathA(), { token: fixtures.orgA.ownerToken, body: bookBody(seed, at("09:00")) });
  const tokenB = fixtures.orgB.ownerToken;
  for (const res of [
    await call(ctx.base, "GET", pathA(`/${a.data.id}`), { token: tokenB }),
    await call(ctx.base, "GET", pathA(`?from=${DAY}&to=${DAY}`), { token: tokenB }),
    await call(ctx.base, "PATCH", pathA(`/${a.data.id}`), { token: tokenB, body: { notes: "x" } }),
    await call(ctx.base, "POST", pathA(`/${a.data.id}/cancel`), { token: tokenB, body: {} }),
    await call(ctx.base, "POST", pathA(`/${a.data.id}/complete`), { token: tokenB }),
  ]) {
    assert.equal(res.status, 403);
  }
});

test("org A's appointment id used on org B's OWN path resolves 404 for get/reschedule/cancel/complete — and is left untouched", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Iso Id");
  const a = await call(ctx.base, "POST", pathA(), { token: fixtures.orgA.ownerToken, body: bookBody(seed, at("09:00")) });
  const pathB = `/organizations/${fixtures.orgB.id}/appointments/${a.data.id}`;
  const tokenB = fixtures.orgB.ownerToken;
  for (const res of [
    await call(ctx.base, "GET", pathB, { token: tokenB }),
    await call(ctx.base, "PATCH", pathB, { token: tokenB, body: { startAt: at("12:00") } }),
    await call(ctx.base, "POST", `${pathB}/cancel`, { token: tokenB, body: {} }),
    await call(ctx.base, "POST", `${pathB}/complete`, { token: tokenB }),
  ]) {
    assert.equal(res.status, 404);
    assert.equal(res.error.code, "APPOINTMENT_NOT_FOUND");
  }
  const listedByB = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/appointments?from=${DAY}&to=${DAY}`, { token: tokenB });
  assert.ok(!listedByB.data.some((row: { id: string }) => row.id === a.data.id));
  assert.equal((await call(ctx.base, "GET", pathA(`/${a.data.id}`), { token: fixtures.orgA.ownerToken })).data.status, "SCHEDULED");
});

test("org B cannot book using org A's Customer, Professional or Service (404 each), nor read org A's bookable slots", async () => {
  const a = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Iso Refs A");
  const b = await seedBookable(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "E2E Iso Refs B");
  const pathB = `/organizations/${fixtures.orgB.id}/appointments`;
  const tokenB = fixtures.orgB.ownerToken;
  for (const override of [{ customerId: a.customer.id }, { professionalId: a.professional.id }, { serviceId: a.service.id }]) {
    const res = await call(ctx.base, "POST", pathB, { token: tokenB, body: bookBody(b, at("09:00"), override) });
    assert.equal(res.status, 404, JSON.stringify(override));
  }
  const slots = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/professionals/${a.professional.id}/bookable-slots?date=${DAY}&serviceId=${a.service.id}`, { token: tokenB });
  assert.equal(slots.status, 404);
});

test("the same interval in two organizations never conflicts", async () => {
  const a = await seedBookable(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "E2E Iso Conflict A");
  const b = await seedBookable(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "E2E Iso Conflict B");
  assert.equal((await call(ctx.base, "POST", pathA(), { token: fixtures.orgA.ownerToken, body: bookBody(a, at("16:00")) })).status, 201);
  assert.equal((await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/appointments`, { token: fixtures.orgB.ownerToken, body: bookBody(b, at("16:00")) })).status, 201);
});

test("a service credential scoped to org A cannot operate on org B", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/appointments?from=${DAY}&to=${DAY}`, { token: fixtures.apiKeys.integrationA.secret });
  assert.equal(res.status, 403);
});
