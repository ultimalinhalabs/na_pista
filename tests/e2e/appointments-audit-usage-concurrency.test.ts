import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { TZ, at, bookBody, call, loadF27Fixtures, registerF27Credentials, seedBookable, setTimezone, startApp, usageQuantity } from "./appointmentsHelpers.js";

/** F27 brief §57 — real audit rows, real Platform usage (after commit only), and concurrent HTTP booking against the real exclusion constraint. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF27Fixtures();
const pathA = (suffix = "") => `/organizations/${fixtures.orgA.id}/appointments${suffix}`;
const token = () => fixtures.orgA.ownerToken;

before(async () => {
  ctx = await startApp();
  registerF27Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, TZ);
});
after(() => ctx.close());

async function send(method: string, path: string, requestId: string, body?: unknown) {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "x-request-id": requestId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as { data?: { id: string } } };
}

test("audit: created / updated / rescheduled / canceled rows exist with the real request id", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, token(), "E2E Audit");
  const stamp = Date.now();
  const created = await send("POST", pathA(), `f27-created-${stamp}`, bookBody(seed, at("09:00")));
  const id = created.json.data!.id;
  await send("PATCH", pathA(`/${id}`), `f27-updated-${stamp}`, { notes: "n" });
  await send("PATCH", pathA(`/${id}`), `f27-rescheduled-${stamp}`, { startAt: at("10:00") });
  await send("POST", pathA(`/${id}/cancel`), `f27-canceled-${stamp}`, {});

  const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, id)));
  const byAction = Object.fromEntries(rows.map((row) => [row.action, row.requestId]));
  assert.equal(byAction["appointment.created"], `f27-created-${stamp}`);
  assert.equal(byAction["appointment.updated"], `f27-updated-${stamp}`);
  assert.equal(byAction["appointment.rescheduled"], `f27-rescheduled-${stamp}`);
  assert.equal(byAction["appointment.canceled"], `f27-canceled-${stamp}`);
});

test("reads (list, get, bookable slots) produce no audit rows", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, token(), "E2E Audit Reads");
  const created = await call(ctx.base, "POST", pathA(), { token: token(), body: bookBody(seed, at("09:00")) });
  const before = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, created.data.id));
  await call(ctx.base, "GET", pathA(`/${created.data.id}`), { token: token() });
  await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${seed.professional.id}/bookable-slots?date=${at("09:00").slice(0, 10)}&serviceId=${seed.service.id}`, { token: token() });
  const afterRows = await db.select().from(auditEvents).where(eq(auditEvents.resourceId, created.data.id));
  assert.equal(afterRows.length, before.length);
});

test("usage: a successful booking increases api_requests on the real Platform; a conflicting (rolled-back) one does not", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, token(), "E2E Usage");
  const before = await usageQuantity(fixtures, fixtures.orgA.id, token());
  assert.equal((await call(ctx.base, "POST", pathA(), { token: token(), body: bookBody(seed, at("12:00")) })).status, 201);
  const afterSuccess = await usageQuantity(fixtures, fixtures.orgA.id, token());
  assert.equal(afterSuccess, before + 1, "exactly one api_requests unit for the committed booking");

  const conflict = await call(ctx.base, "POST", pathA(), { token: token(), body: bookBody(seed, at("12:00")) });
  assert.equal(conflict.status, 409);
  assert.equal(await usageQuantity(fixtures, fixtures.orgA.id, token()), afterSuccess, "no usage for a failed transaction");
});

test("CONCURRENCY over HTTP: 5 simultaneous POSTs for the same slot -> exactly one 201, four 409 APPOINTMENT_CONFLICT", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, token(), "E2E Concurrency");
  const results = await Promise.all(Array.from({ length: 5 }, () => call(ctx.base, "POST", pathA(), { token: token(), body: bookBody(seed, at("14:00")) })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const losers = results.filter((r) => r.status !== 201);
  assert.equal(losers.length, 4);
  assert.ok(
    losers.every((r) => r.status === 409 && r.error.code === "APPOINTMENT_CONFLICT"),
    `losers: ${JSON.stringify(losers.map((r) => ({ status: r.status, error: r.error })))}`,
  );

  const day = at("14:00").slice(0, 10);
  const listed = await call(ctx.base, "GET", pathA(`?from=${day}&to=${day}&professionalId=${seed.professional.id}&status=SCHEDULED`), { token: token() });
  assert.equal(listed.data.length, 1);
});

test("CONCURRENCY over HTTP: two simultaneous reschedules of different appointments into the same target -> exactly one 200", async () => {
  const seed = await seedBookable(ctx.base, fixtures.orgA.id, token(), "E2E Concurrency Reschedule");
  const a = await call(ctx.base, "POST", pathA(), { token: token(), body: bookBody(seed, at("09:00")) });
  const b = await call(ctx.base, "POST", pathA(), { token: token(), body: bookBody(seed, at("11:00")) });
  const [ra, rb] = await Promise.all([
    call(ctx.base, "PATCH", pathA(`/${a.data.id}`), { token: token(), body: { startAt: at("16:00") } }),
    call(ctx.base, "PATCH", pathA(`/${b.data.id}`), { token: token(), body: { startAt: at("16:00") } }),
  ]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 409]);
  assert.equal([ra, rb].find((r) => r.status === 409)!.error.code, "APPOINTMENT_CONFLICT");
});
