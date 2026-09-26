import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { appointments, auditEvents } from "../../src/db/schema/index.js";
import { DAY, TZ, at, bookBody, call, createFreshSubscribedOrg, loadF27Fixtures, registerF27Credentials, seedBookable, setTimezone, startApp, usageQuantity } from "./appointmentsHelpers.js";

/**
 * F28B (ADR-048) — POST …/appointments/:id/no-show over real HTTP + real UL Platform + real PostgreSQL.
 *
 * Test-harness note: the API (correctly) refuses to create a booking in the past, so a past appointment is obtained
 * by booking in the future and then shifting THAT row's times directly in the database (test infrastructure only —
 * the same technique F27's completion E2E uses). No client can do this through the API.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF27Fixtures();
const owner = () => fixtures.orgA.ownerToken;
const pathA = (suffix = "") => `/organizations/${fixtures.orgA.id}/appointments${suffix}`;

before(async () => {
  ctx = await startApp();
  registerF27Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, owner(), TZ);
});
after(() => ctx.close());

async function shiftDays(id: string, days: number) {
  await db
    .update(appointments)
    .set({ startAt: sql`${appointments.startAt} + make_interval(days => ${days})`, endAt: sql`${appointments.endAt} + make_interval(days => ${days})` })
    .where(eq(appointments.id, id));
}

/** A SCHEDULED appointment of org A whose start is ~30 days in the past. */
async function pastAppointmentA(label: string, time = "09:00") {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, owner(), label);
  const created = await call(ctx.base, "POST", pathA(), { token: owner(), body: bookBody(seed, at(time)) });
  assert.equal(created.status, 201);
  await shiftDays(created.data.id, -30);
  return { seed, id: created.data.id as string };
}

const noShow = (id: string, token: string | undefined, body?: unknown) => call(ctx.base, "POST", pathA(`/${id}/no-show`), { token, body });

test("OWNER: 200 NO_SHOW with noShowAt; every subsequent mutation -> 409 INVALID_APPOINTMENT_STATE; audit row written", async () => {
  const { id } = await pastAppointmentA("E2E NoShow Owner");
  const res = await noShow(id, owner());
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "NO_SHOW");
  assert.ok(res.data.noShowAt);
  assert.equal(res.data.canceledAt, null);
  assert.equal(res.data.completedAt, null);

  for (const next of [
    await noShow(id, owner()),
    await call(ctx.base, "POST", pathA(`/${id}/cancel`), { token: owner(), body: {} }),
    await call(ctx.base, "POST", pathA(`/${id}/complete`), { token: owner() }),
    await call(ctx.base, "PATCH", pathA(`/${id}`), { token: owner(), body: { startAt: at("15:00") } }),
    await call(ctx.base, "PATCH", pathA(`/${id}`), { token: owner(), body: { notes: "x" } }),
  ]) {
    assert.equal(next.status, 409);
    assert.equal(next.error.code, "INVALID_APPOINTMENT_STATE");
  }
  const audits = await db.select().from(auditEvents).where(and(eq(auditEvents.resourceId, id), eq(auditEvents.action, "appointment.no_show")));
  assert.equal(audits.length, 1);
});

test("before start_at -> 409 APPOINTMENT_NO_SHOW_TOO_EARLY and the appointment stays SCHEDULED", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, owner(), "E2E NoShow Early");
  const created = await call(ctx.base, "POST", pathA(), { token: owner(), body: bookBody(seed, at("09:00")) });
  const res = await noShow(created.data.id, owner());
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "APPOINTMENT_NO_SHOW_TOO_EARLY");
  assert.equal((await call(ctx.base, "GET", pathA(`/${created.data.id}`), { token: owner() })).data.status, "SCHEDULED");
});

test("any request body is rejected (400, .strict()); an empty object is accepted", async () => {
  const { id } = await pastAppointmentA("E2E NoShow Body");
  const withBody = await noShow(id, owner(), { reason: "não veio" });
  assert.equal(withBody.status, 400);
  assert.equal(withBody.error.code, "VALIDATION_ERROR");
  assert.equal((await noShow(id, owner(), {})).status, 200);
});

test("NO_SHOW keeps occupying: with the row at its original (future) time, a new booking over it -> 409 APPOINTMENT_CONFLICT", async () => {
  const { seed, id } = await pastAppointmentA("E2E NoShow Occupies", "10:00");
  assert.equal((await noShow(id, owner())).status, 200);
  await shiftDays(id, 30); // back to its original slot (harness only) — still NO_SHOW
  const clash = await call(ctx.base, "POST", pathA(), { token: owner(), body: bookBody(seed, at("10:30")) });
  assert.equal(clash.status, 409);
  assert.equal(clash.error.code, "APPOINTMENT_CONFLICT");
  assert.doesNotMatch(JSON.stringify(clash.error), /no_overlap|exclusion|23P01/i);
  assert.equal((await call(ctx.base, "POST", pathA(), { token: owner(), body: bookBody(seed, at("11:00")) })).status, 201, "adjacent still allowed");
});

test("MANAGER: 200; STAFF: 403 FORBIDDEN and nothing changes", async () => {
  const a = await pastAppointmentA("E2E NoShow Manager");
  assert.equal((await noShow(a.id, fixtures.managerA.token)).status, 200);

  const b = await pastAppointmentA("E2E NoShow Staff");
  const staff = await noShow(b.id, fixtures.staffA.token);
  assert.equal(staff.status, 403);
  assert.equal(staff.error.code, "FORBIDDEN");
  assert.equal((await call(ctx.base, "GET", pathA(`/${b.id}`), { token: owner() })).data.status, "SCHEDULED");
});

test("ADMIN: 200 (fresh subscribed org where an existing fixture user is granted the ADMIN role via the real Platform API)", async () => {
  const org = await createFreshSubscribedOrg(fixtures);
  const membership = await call(fixtures.platformBaseUrl, "POST", `/organizations/${org.id}/memberships`, {
    token: org.ownerToken,
    body: { userId: fixtures.managerA.id, roleKey: "ADMIN" },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.error));
  const { _clearMembershipCache } = await import("../../src/platform/membership.js");
  _clearMembershipCache();

  await setTimezone(ctx.base, org.id, org.ownerToken, TZ);
  const seed = await seedBookable(ctx.base, org.id, org.ownerToken, "E2E NoShow Admin");
  const created = await call(ctx.base, "POST", `/organizations/${org.id}/appointments`, { token: org.ownerToken, body: bookBody(seed, at("09:00")) });
  await shiftDays(created.data.id, -30);
  const res = await call(ctx.base, "POST", `/organizations/${org.id}/appointments/${created.data.id}/no-show`, { token: fixtures.managerA.token });
  assert.equal(res.status, 200, JSON.stringify(res.error));
  assert.equal(res.data.status, "NO_SHOW");
});

test("service credentials: catalog.write -> 200; usage.write/event.publish only -> 403; no Authorization -> 401", async () => {
  const a = await pastAppointmentA("E2E NoShow Credential");
  assert.equal((await noShow(a.id, fixtures.apiKeys.integrationA.secret)).status, 200);
  const b = await pastAppointmentA("E2E NoShow Scope");
  assert.equal((await noShow(b.id, fixtures.apiKeys.platformFacingA.secret)).status, 403);
  assert.equal((await noShow(b.id, undefined)).status, 401);
});

test("tenant isolation: org B's member on org A's path -> 403; org A's id on org B's own path -> 404; row untouched", async () => {
  const { id } = await pastAppointmentA("E2E NoShow Tenant");
  assert.equal((await noShow(id, fixtures.orgB.ownerToken)).status, 403);
  const foreign = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/appointments/${id}/no-show`, { token: fixtures.orgB.ownerToken });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.error.code, "APPOINTMENT_NOT_FOUND");
  assert.equal((await call(ctx.base, "GET", pathA(`/${id}`), { token: owner() })).data.status, "SCHEDULED");
});

test("entitlement: unsubscribed org C -> 503 without a platform credential, 403 ENTITLEMENT_REQUIRED with one", async () => {
  const path = `/organizations/${fixtures.orgC.id}/appointments/${fixtures.orgC.id}/no-show`;
  assert.equal((await call(ctx.base, "POST", path, { token: fixtures.orgC.ownerToken })).status, 503);
  const keyRes = await call(fixtures.platformBaseUrl, "POST", `/organizations/${fixtures.orgC.id}/api-keys`, {
    token: fixtures.orgC.ownerToken,
    body: { applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] },
  });
  assert.equal(keyRes.status, 201);
  const { registerServiceCredential } = await import("../../src/platform/serviceAuth.js");
  registerServiceCredential(fixtures.orgC.id, keyRes.data.secret);
  const res = await call(ctx.base, "POST", path, { token: fixtures.orgC.ownerToken });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, "ENTITLEMENT_REQUIRED");
});

test("usage (real Platform meter): +1 for a successful NO_SHOW; unchanged after too-early and invalid-state attempts", async () => {
  const { id } = await pastAppointmentA("E2E NoShow Usage");
  const future = await call(ctx.base, "POST", pathA(), { token: owner(), body: bookBody(await seedBookable(ctx.base, fixtures.orgA.id, owner(), "E2E NoShow Usage 2"), at("09:00", DAY)) });
  const before = await usageQuantity(fixtures, fixtures.orgA.id, owner());
  assert.equal((await noShow(future.data.id, owner())).status, 409, "too early");
  assert.equal(await usageQuantity(fixtures, fixtures.orgA.id, owner()), before);
  assert.equal((await noShow(id, owner())).status, 200);
  const afterSuccess = await usageQuantity(fixtures, fixtures.orgA.id, owner());
  assert.equal(afterSuccess, before + 1);
  assert.equal((await noShow(id, owner())).status, 409, "invalid state");
  assert.equal(await usageQuantity(fixtures, fixtures.orgA.id, owner()), afterSuccess);
});

test("list filter status=NO_SHOW returns only no-show appointments", async () => {
  const { id } = await pastAppointmentA("E2E NoShow Filter");
  await noShow(id, owner());
  const [row] = await db.select({ startAt: appointments.startAt }).from(appointments).where(eq(appointments.id, id));
  const day = row!.startAt.toISOString().slice(0, 10);
  const listed = await call(ctx.base, "GET", pathA(`?from=${day}&to=${day}&status=NO_SHOW`), { token: owner() });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.some((a: { id: string }) => a.id === id));
  assert.ok(listed.data.every((a: { status: string }) => a.status === "NO_SHOW"));
});
