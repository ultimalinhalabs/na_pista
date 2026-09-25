import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { appointments } from "../../src/db/schema/index.js";
import { addDays } from "../../src/modules/appointments/time.js";
import { DAY, TZ, addProfessional, at, bookBody, call, createFreshSubscribedOrg, loadF27Fixtures, registerF27Credentials, seedBookable, setTimezone, startApp } from "./appointmentsHelpers.js";

/** F27 brief §57 — the full booking lifecycle over real HTTP + real Platform + real PostgreSQL. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF27Fixtures();
const A = () => ({ base: ctx.base, org: fixtures.orgA.id, token: fixtures.orgA.ownerToken });
const path = (suffix = "") => `/organizations/${fixtures.orgA.id}/appointments${suffix}`;

before(async () => {
  ctx = await startApp();
  registerF27Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, TZ);
});
after(() => ctx.close());

test("create -> 201 SCHEDULED with server-derived end, duration and snapshots; get returns the same", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Create");
  const created = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "SCHEDULED");
  assert.equal(created.data.startAt, at("09:00"));
  assert.equal(created.data.endAt, at("10:00"));
  assert.equal(created.data.durationMinutes, 60);
  assert.equal(created.data.serviceName, "Serviço E2E Create");
  assert.equal(created.data.servicePrice, "10000.00");
  assert.equal(created.data.currency, "AOA");

  const got = await call(ctx.base, "GET", path(`/${created.data.id}`), { token: A().token });
  assert.equal(got.status, 200);
  assert.deepEqual(got.data, created.data);
});

test("create accepts any explicit offset spelling of the same instant; bare local strings are rejected (400)", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Offset");
  const withOffset = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, `${DAY}T11:00:00+01:00`) });
  assert.equal(withOffset.status, 201);
  assert.equal(withOffset.data.startAt, at("11:00"));
  const bare = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, `${DAY}T13:00:00`) });
  assert.equal(bare.status, 400);
  assert.equal(bare.error.code, "VALIDATION_ERROR");
});

test("strict body: endAt/status/price/organizationId cannot be supplied on create; status/customer/service cannot be PATCHed", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Strict");
  for (const extra of [{ endAt: at("12:00") }, { status: "COMPLETED" }, { servicePrice: "1.00" }, { organizationId: fixtures.orgB.id }]) {
    const res = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00"), extra) });
    assert.equal(res.status, 400, JSON.stringify(extra));
  }
  const created = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });
  for (const patch of [{ status: "COMPLETED" }, { status: "CANCELED" }, { customerId: seed.customer.id }, { serviceId: seed.service.id }, { endAt: at("12:00") }]) {
    const res = await call(ctx.base, "PATCH", path(`/${created.data.id}`), { token: A().token, body: patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
  }
  assert.equal((await call(ctx.base, "GET", path(`/${created.data.id}`), { token: A().token })).data.status, "SCHEDULED");
});

test("list: bounded local-date window + filters; >31 days and missing range rejected", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E List");
  const a = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });
  const b = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("10:00", addDays(DAY, 1))) });
  const day = await call(ctx.base, "GET", path(`?from=${DAY}&to=${DAY}&professionalId=${seed.professional.id}`), { token: A().token });
  assert.equal(day.status, 200);
  assert.deepEqual(day.data.map((row: { id: string }) => row.id), [a.data.id]);
  const two = await call(ctx.base, "GET", path(`?from=${DAY}&to=${addDays(DAY, 1)}&customerId=${seed.customer.id}`), { token: A().token });
  assert.deepEqual(two.data.map((row: { id: string }) => row.id), [a.data.id, b.data.id]);

  assert.equal((await call(ctx.base, "GET", path(`?from=${DAY}&to=${addDays(DAY, 31)}`), { token: A().token })).status, 400);
  assert.equal((await call(ctx.base, "GET", path(), { token: A().token })).status, 400);
});

test("bookable slots: F26 start times minus bookings (canceled ones do not block), absolute instants", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Slots");
  await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("10:00")) });
  const canceled = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("14:00")) });
  await call(ctx.base, "POST", path(`/${canceled.data.id}/cancel`), { token: A().token, body: {} });

  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${seed.professional.id}/bookable-slots?date=${DAY}&serviceId=${seed.service.id}`, { token: A().token });
  assert.equal(res.status, 200);
  assert.equal(res.data.timezone, TZ);
  const times = res.data.slots.map((slot: { localStartTime: string }) => slot.localStartTime);
  assert.ok(!times.includes("10:00") && !times.includes("09:30") && !times.includes("10:45"));
  assert.ok(times.includes("09:00") && times.includes("11:00") && times.includes("14:00"));
  assert.equal(res.data.slots.find((slot: { localStartTime: string }) => slot.localStartTime === "09:00").startAt, at("09:00"));

  assert.equal((await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${seed.professional.id}/bookable-slots?date=${DAY}`, { token: A().token })).status, 400, "serviceId required");
});

test("conflict: identical and partial overlaps -> 409 APPOINTMENT_CONFLICT (no internals leaked); adjacent -> 201", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Conflict");
  assert.equal((await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("10:00")) })).status, 201);
  for (const time of ["10:00", "10:30", "09:30"]) {
    const res = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at(time)) });
    assert.equal(res.status, 409, time);
    assert.equal(res.error.code, "APPOINTMENT_CONFLICT");
    assert.doesNotMatch(JSON.stringify(res.error), /appointments_professional_no_overlap|exclusion|23P01|tstzrange|sql/i);
  }
  assert.equal((await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("11:00")) })).status, 201);
  assert.equal((await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) })).status, 201);
});

test("reschedule: PATCH startAt moves the same appointment; into an occupied interval -> 409 APPOINTMENT_CONFLICT; to another professional works", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Reschedule");
  const blocker = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("15:00")) });
  assert.equal(blocker.status, 201);
  const a = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });

  const moved = await call(ctx.base, "PATCH", path(`/${a.data.id}`), { token: A().token, body: { startAt: at("12:00") } });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.id, a.data.id);
  assert.equal(moved.data.startAt, at("12:00"));
  assert.equal(moved.data.durationMinutes, 60);

  const clash = await call(ctx.base, "PATCH", path(`/${a.data.id}`), { token: A().token, body: { startAt: at("15:30") } });
  assert.equal(clash.status, 409);
  assert.equal(clash.error.code, "APPOINTMENT_CONFLICT");

  const other = await addProfessional(ctx.base, fixtures.orgA.id, A().token, "Profissional E2E Reschedule 2", seed.service.id);
  const toOther = await call(ctx.base, "PATCH", path(`/${a.data.id}`), { token: A().token, body: { professionalId: other.id, startAt: at("15:00") } });
  assert.equal(toOther.status, 200, "15:00 is free for the OTHER professional");
  assert.equal(toOther.data.professionalId, other.id);
  assert.equal(toOther.data.customerId, seed.customer.id);
});

test("outside availability -> 409 APPOINTMENT_OUTSIDE_AVAILABILITY; beyond 365 days -> 400 BOOKING_HORIZON_EXCEEDED; past -> 400", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Window");
  const outside = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("19:00")) });
  assert.equal(outside.status, 409);
  assert.equal(outside.error.code, "APPOINTMENT_OUTSIDE_AVAILABILITY");
  const offGrid = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:10")) });
  assert.equal(offGrid.error.code, "APPOINTMENT_OUTSIDE_AVAILABILITY");

  const far = new Date(Date.now() + 400 * 86_400_000);
  far.setUTCSeconds(0, 0);
  const horizon = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, far.toISOString()) });
  assert.equal(horizon.status, 400);
  assert.equal(horizon.error.code, "BOOKING_HORIZON_EXCEEDED");

  const past = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00", addDays(DAY, -30))) });
  assert.equal(past.status, 400);
});

test("cancel: 200 CANCELED with reason, releases the slot, terminal (second cancel / reschedule -> 409 INVALID_APPOINTMENT_STATE)", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Cancel");
  const a = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });
  const canceled = await call(ctx.base, "POST", path(`/${a.data.id}/cancel`), { token: A().token, body: { reason: "Pedido do cliente" } });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.status, "CANCELED");
  assert.equal(canceled.data.cancellationReason, "Pedido do cliente");
  assert.ok(canceled.data.canceledAt);

  assert.equal((await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) })).status, 201, "interval released");
  const again = await call(ctx.base, "POST", path(`/${a.data.id}/cancel`), { token: A().token, body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.error.code, "INVALID_APPOINTMENT_STATE");
  assert.equal((await call(ctx.base, "PATCH", path(`/${a.data.id}`), { token: A().token, body: { startAt: at("16:00") } })).error.code, "INVALID_APPOINTMENT_STATE");
});

test("complete: before start -> 409 APPOINTMENT_COMPLETION_TOO_EARLY; after start (row moved into the past by the test harness) -> 200 COMPLETED, terminal", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Complete");
  const a = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });
  const early = await call(ctx.base, "POST", path(`/${a.data.id}/complete`), { token: A().token });
  assert.equal(early.status, 409);
  assert.equal(early.error.code, "APPOINTMENT_COMPLETION_TOO_EARLY");

  // Test-infrastructure only: shift THIS row 30 days back so the real server clock is past its start (the API never lets a client do this).
  await db
    .update(appointments)
    .set({ startAt: sql`${appointments.startAt} - interval '30 days'`, endAt: sql`${appointments.endAt} - interval '30 days'` })
    .where(eq(appointments.id, a.data.id));

  const done = await call(ctx.base, "POST", path(`/${a.data.id}/complete`), { token: A().token });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, "COMPLETED");
  assert.ok(done.data.completedAt);
  assert.equal((await call(ctx.base, "POST", path(`/${a.data.id}/cancel`), { token: A().token, body: {} })).error.code, "INVALID_APPOINTMENT_STATE");
});

test("notes: set and clear via PATCH; over 2000 chars -> 400", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Notes");
  const a = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00"), { notes: "Traz toalha" }) });
  assert.equal(a.data.notes, "Traz toalha");
  assert.equal((await call(ctx.base, "PATCH", path(`/${a.data.id}`), { token: A().token, body: { notes: null } })).data.notes, null);
  assert.equal((await call(ctx.base, "PATCH", path(`/${a.data.id}`), { token: A().token, body: { notes: "x".repeat(2001) } })).status, 400);
});

test("invalid / archived resources: unknown service 404; archived Service, Professional, Customer -> 409; existing appointments survive", async () => {
  const seed = await seedBookable(A().base, A().org, A().token, "E2E Archived");
  const existing = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("09:00")) });

  const unknown = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("11:00"), { serviceId: "11111111-1111-4111-8111-111111111111" }) });
  assert.equal(unknown.status, 404);

  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${seed.service.id}`, { token: A().token, body: { status: "ARCHIVED" } });
  const archivedService = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("11:00")) });
  assert.equal(archivedService.error.code, "SERVICE_ARCHIVED");
  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${seed.service.id}`, { token: A().token, body: { status: "ACTIVE" } });

  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${seed.professional.id}`, { token: A().token, body: { status: "ARCHIVED" } });
  const archivedProfessional = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("11:00")) });
  assert.equal(archivedProfessional.error.code, "PROFESSIONAL_ARCHIVED");
  const rescheduleArchived = await call(ctx.base, "PATCH", path(`/${existing.data.id}`), { token: A().token, body: { startAt: at("12:00") } });
  assert.equal(rescheduleArchived.error.code, "PROFESSIONAL_ARCHIVED");
  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${seed.professional.id}`, { token: A().token, body: { status: "ACTIVE" } });

  await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/customers/${seed.customer.id}`, { token: A().token });
  const archivedCustomer = await call(ctx.base, "POST", path(), { token: A().token, body: bookBody(seed, at("11:00")) });
  assert.equal(archivedCustomer.status, 409);
  assert.equal(archivedCustomer.error.code, "CUSTOMER_ARCHIVED");

  const stillThere = await call(ctx.base, "GET", path(`/${existing.data.id}`), { token: A().token });
  assert.equal(stillThere.data.status, "SCHEDULED");
  assert.equal((await call(ctx.base, "POST", path(`/${existing.data.id}/cancel`), { token: A().token, body: {} })).status, 200, "closing out is always allowed");
});

test("timezone not configured (fresh subscribed org) -> 409 TIMEZONE_NOT_CONFIGURED on create, list and bookable slots", async () => {
  const org = await createFreshSubscribedOrg(fixtures);
  const seed = await seedBookable(ctx.base, org.id, org.ownerToken, "E2E NoTz");
  const create = await call(ctx.base, "POST", `/organizations/${org.id}/appointments`, { token: org.ownerToken, body: bookBody(seed, at("09:00")) });
  assert.equal(create.status, 409);
  assert.equal(create.error.code, "TIMEZONE_NOT_CONFIGURED");
  assert.equal((await call(ctx.base, "GET", `/organizations/${org.id}/appointments?from=${DAY}&to=${DAY}`, { token: org.ownerToken })).error.code, "TIMEZONE_NOT_CONFIGURED");
  assert.equal(
    (await call(ctx.base, "GET", `/organizations/${org.id}/professionals/${seed.professional.id}/bookable-slots?date=${DAY}&serviceId=${seed.service.id}`, { token: org.ownerToken })).error.code,
    "TIMEZONE_NOT_CONFIGURED",
  );
});

test("unknown appointment id -> 404 APPOINTMENT_NOT_FOUND", async () => {
  const res = await call(ctx.base, "GET", path("/11111111-1111-4111-8111-111111111111"), { token: A().token });
  assert.equal(res.status, 404);
  assert.equal(res.error.code, "APPOINTMENT_NOT_FOUND");
});
