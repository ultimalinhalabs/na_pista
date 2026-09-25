import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq, ne, sql } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { appointments, auditEvents } from "../../src/db/schema/index.js";
import { recordAuditEvent } from "../../src/modules/audit/service.js";
import { archiveCustomer, createCustomer } from "../../src/modules/customers/service.js";
import { updateOrganizationSettings } from "../../src/modules/organizationSettings/service.js";
import { associateService, createProfessional, removeAssociation, updateProfessionalOrThrow } from "../../src/modules/professionals/service.js";
import { createExceptionOrThrow, replaceScheduleOrThrow } from "../../src/modules/scheduling/service.js";
import { createService, updateServiceOrThrow } from "../../src/modules/services/service.js";
import { insertAppointment } from "../../src/modules/appointments/repository.js";
import {
  NO_OVERLAP_CONSTRAINT,
  cancelAppointment,
  completeAppointment,
  createAppointment,
  getAppointmentOrThrow,
  getBookableSlotsOrThrow,
  listAppointmentsOrThrow,
  mapBookingWriteError,
  updateAppointmentOrThrow,
} from "../../src/modules/appointments/service.js";
import { addDays, localToInstant, toLocal } from "../../src/modules/appointments/time.js";
import {
  AppointmentCompletionTooEarlyError,
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentOutsideAvailabilityError,
  BookingHorizonExceededError,
  CustomerArchivedError,
  InvalidAppointmentStateError,
  NotFoundError,
  ProfessionalArchivedError,
  ServiceArchivedError,
  TimezoneNotConfiguredError,
  ValidationError,
} from "../../src/shared/errors.js";

/**
 * F27 integration + CONCURRENCY tests — real PostgreSQL (the project's own
 * database, with the real `appointments_professional_no_overlap` exclusion
 * constraint), no HTTP, no Platform. Concurrency tests fire genuinely
 * simultaneous writes over the real connection pool (max 5 connections —
 * each `db.transaction` holds its own), exactly the F22/F23 pattern; one
 * test additionally PROVES cross-session blocking by observing the second
 * writer waiting on a lock in `pg_stat_activity` before releasing the first.
 */
const TZ = "Africa/Luanda";
const actor = { type: "user" as const, id: "test-actor-f27" };
type Org = { organizationId: string };

after(() => queryClient.end());

/** A local date comfortably inside the booking window, per test run. */
const DAY = addDays(toLocal(new Date(), TZ).date, 10);
const at = (time: string, date = DAY) => localToInstant(date, time, TZ)!;

async function seedOrg(timezone: string | null = TZ): Promise<Org> {
  const org = { organizationId: randomUUID() };
  if (timezone) await updateOrganizationSettings(org, actor, "req-seed", timezone);
  return org;
}

/** Customer + Service(60 min, 10000.00) + Professional associated with it, working 08:00-18:00 every day. */
async function seedBookable(org: Org, options: { durationMinutes?: number; price?: string } = {}) {
  const customer = await createCustomer(org, actor, "req-seed", { name: `Cliente ${randomUUID().slice(0, 6)}` });
  const service = await createService(org, actor, "req-seed", {
    name: "Personal Training",
    durationMinutes: options.durationMinutes ?? 60,
    ...(options.price !== undefined ? { price: options.price } : { price: "10000.00" }),
  });
  const professional = await addProfessional(org, service.id);
  return { customer, service, professional };
}

async function addProfessional(org: Org, serviceId: string) {
  const professional = await createProfessional(org, actor, "req-seed", { name: `Profissional ${randomUUID().slice(0, 6)}` });
  await associateService(org, actor, "req-seed", professional.id, serviceId);
  await replaceScheduleOrThrow(
    org,
    actor,
    "req-seed",
    professional.id,
    [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startLocalTime: "08:00", endLocalTime: "18:00" })),
  );
  return professional;
}

function book(org: Org, seed: Awaited<ReturnType<typeof seedBookable>>, startAt: Date, overrides: { professionalId?: string; now?: Date } = {}) {
  return createAppointment(
    org,
    actor,
    `req-${randomUUID()}`,
    { customerId: seed.customer.id, professionalId: overrides.professionalId ?? seed.professional.id, serviceId: seed.service.id, startAt },
    { now: overrides.now },
  );
}

function split<T>(results: PromiseSettledResult<T>[]) {
  return {
    fulfilled: results.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled").map((r) => r.value),
    rejected: results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason),
  };
}

async function occupyingRows(org: Org, professionalId: string) {
  return db
    .select()
    .from(appointments)
    .where(and(eq(appointments.organizationId, org.organizationId), eq(appointments.professionalId, professionalId), ne(appointments.status, "CANCELED")));
}

/** No two occupying rows of a professional overlap — the invariant, checked directly on the table. */
function assertNoOverlap(rows: { startAt: Date; endAt: Date }[]) {
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      assert.ok(!(a.startAt < b.endAt && b.startAt < a.endAt), `overlap between ${a.startAt.toISOString()} and ${b.startAt.toISOString()}`);
    }
  }
}

/** Counts `recordUsage` calls for an org during `fn` (no credential is registered in integration tests, so each call logs `usage.write.skipped_no_credential` exactly once). */
async function countUsageCalls(organizationId: string, fn: () => Promise<unknown>) {
  const original = console.log;
  let count = 0;
  console.log = (...args: unknown[]) => {
    const line = String(args[0]);
    if (line.includes('"usage.write.skipped_no_credential"') && line.includes(organizationId)) count++;
    else original(...args);
  };
  try {
    await fn().catch(() => undefined);
  } finally {
    console.log = original;
  }
  return count;
}

// ======================= SCHEMA / MIGRATION =======================

test("migration: appointments exists and the exclusion constraint is live, exactly as ADR-044 defines it", async () => {
  const rows = await db.execute<{ conname: string; contype: string; def: string }>(sql`
    select c.conname, c.contype, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'na_pista' and t.relname = 'appointments' and c.contype = 'x'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.conname, NO_OVERLAP_CONSTRAINT);
  assert.match(rows[0]!.def, /EXCLUDE USING gist \(organization_id WITH =, professional_id WITH =, tstzrange\(start_at, end_at, '\[\)'::text\) WITH &&\) WHERE \(\(status <> 'CANCELED'::text\)\)/);
});

test("migration: btree_gist is installed in the `extensions` schema", async () => {
  const rows = await db.execute<{ nspname: string }>(sql`select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'btree_gist'`);
  assert.equal(rows[0]?.nspname, "extensions");
});

test("DB CHECKs: end_at > start_at, valid status, lifecycle timestamps consistent with status (raw inserts bypassing the service)", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const base = { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, serviceName: "x", servicePrice: null, currency: "AOA", notes: null };
  const bad = [
    { ...base, startAt: at("09:00"), endAt: at("09:00") },
    { ...base, startAt: at("09:00"), endAt: at("10:00"), status: "NO_SHOW" },
    { ...base, startAt: at("09:00"), endAt: at("10:00"), status: "CANCELED" }, // no canceled_at
    { ...base, startAt: at("09:00"), endAt: at("10:00"), completedAt: new Date() }, // SCHEDULED with completed_at
    { ...base, startAt: at("09:00"), endAt: at("10:00"), cancellationReason: "x" },
    { ...base, startAt: at("09:00"), endAt: at("10:00"), currency: "kz" },
  ];
  for (const values of bad) {
    const err = await db
      .insert(appointments)
      .values({ organizationId: org.organizationId, ...(values as typeof base & { startAt: Date; endAt: Date }) })
      .catch((e) => e);
    assert.ok(err instanceof Error, `expected rejection for ${JSON.stringify(values)}`);
    assert.match(String((err as Error & { cause?: Error }).cause?.message ?? err), /check constraint|violat/i);
  }
});

test("DB tenant integrity: a raw insert referencing another organization's Customer/Professional/Service fails on the composite FKs", async () => {
  const orgA = await seedOrg();
  const orgB = await seedOrg();
  const a = await seedBookable(orgA);
  const b = await seedBookable(orgB);
  const cases = [
    { customerId: a.customer.id, professionalId: b.professional.id, serviceId: b.service.id, fk: "appointments_customer_org_fk" },
    { customerId: b.customer.id, professionalId: a.professional.id, serviceId: b.service.id, fk: "appointments_professional_org_fk" },
    { customerId: b.customer.id, professionalId: b.professional.id, serviceId: a.service.id, fk: "appointments_service_org_fk" },
  ];
  for (const { fk, ...refs } of cases) {
    const err = await insertAppointment(orgB, { ...refs, startAt: at("09:00"), endAt: at("10:00"), serviceName: "x", servicePrice: null, currency: "AOA", notes: null }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.match(String((err as Error & { cause?: Error }).cause?.message ?? err.message), new RegExp(fk));
  }
});

// ======================= CREATION =======================

test("create: SCHEDULED immediately, all four relationships stored, snapshots taken, duration frozen from the Service", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  assert.equal(appointment.status, "SCHEDULED");
  assert.equal(appointment.organizationId, org.organizationId);
  assert.equal(appointment.customerId, seed.customer.id);
  assert.equal(appointment.professionalId, seed.professional.id);
  assert.equal(appointment.serviceId, seed.service.id);
  assert.equal(appointment.startAt.toISOString(), at("09:00").toISOString());
  assert.equal(appointment.endAt.toISOString(), at("10:00").toISOString());
  assert.equal(appointment.durationMinutes, 60);
  assert.equal(appointment.serviceName, "Personal Training");
  assert.equal(appointment.servicePrice, "10000.00");
  assert.equal(appointment.currency, "AOA");
  assert.equal(appointment.canceledAt, null);
  assert.equal(appointment.completedAt, null);
});

test("create: an unpriced Service is bookable and the price snapshot stays NULL", async () => {
  const org = await seedOrg();
  const customer = await createCustomer(org, actor, "req", { name: "Cliente" });
  const service = await createService(org, actor, "req", { name: "Avaliação", durationMinutes: 30 });
  const professional = await addProfessional(org, service.id);
  const appointment = await createAppointment(org, actor, "req", { customerId: customer.id, professionalId: professional.id, serviceId: service.id, startAt: at("09:00") });
  assert.equal(appointment.servicePrice, null);
  assert.equal(appointment.durationMinutes, 30);
});

test("snapshot immutability: renaming/repricing/re-timing the Service afterwards never changes an existing appointment", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  await updateServiceOrThrow(org, actor, "req", seed.service.id, { name: "Personal Training Premium", price: "15000.00", durationMinutes: 90 });
  const reread = await getAppointmentOrThrow(org, appointment.id);
  assert.equal(reread.serviceName, "Personal Training");
  assert.equal(reread.servicePrice, "10000.00");
  assert.equal(reread.durationMinutes, 60);
  assert.equal(reread.endAt.toISOString(), at("10:00").toISOString());
});

test("create: new bookings after a Service duration change use the NEW duration", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  await updateServiceOrThrow(org, actor, "req", seed.service.id, { durationMinutes: 90 });
  const appointment = await book(org, seed, at("09:00"));
  assert.equal(appointment.durationMinutes, 90);
});

test("create: timezone not configured -> TimezoneNotConfiguredError (fail closed, no default)", async () => {
  const org = await seedOrg(null);
  const seed = await seedBookable(org);
  await assert.rejects(() => book(org, seed, new Date(Date.now() + 86_400_000)), TimezoneNotConfiguredError);
});

test("create: horizon — beyond 365 days -> BookingHorizonExceededError; in the past -> ValidationError", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const now = new Date();
  await assert.rejects(() => book(org, seed, new Date(now.getTime() + 366 * 86_400_000)), BookingHorizonExceededError);
  await assert.rejects(() => book(org, seed, new Date(now.getTime() - 86_400_000)), ValidationError);
});

test("availability: outside working hours, off the 15-min grid, duration overflowing, and a closed exception date are all rejected", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  await assert.rejects(() => book(org, seed, at("07:00")), AppointmentOutsideAvailabilityError);
  await assert.rejects(() => book(org, seed, at("09:10")), AppointmentOutsideAvailabilityError);
  await assert.rejects(() => book(org, seed, at("17:30")), AppointmentOutsideAvailabilityError, "17:30 + 60 > 18:00");
  await createExceptionOrThrow(org, actor, "req", seed.professional.id, { date: addDays(DAY, 1) });
  await assert.rejects(() => book(org, seed, at("09:00", addDays(DAY, 1))), AppointmentOutsideAvailabilityError);
});

test("availability: the manager workaround — a date exception opening extra hours makes an otherwise-outside booking valid (no override flag)", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const date = addDays(DAY, 2);
  await assert.rejects(() => book(org, seed, at("19:00", date)), AppointmentOutsideAvailabilityError);
  await createExceptionOrThrow(org, actor, "req", seed.professional.id, { date, startLocalTime: "19:00", endLocalTime: "21:00" });
  const appointment = await book(org, seed, at("19:00", date));
  assert.equal(appointment.status, "SCHEDULED");
});

test("compatibility: Professional not associated with the Service -> NotFoundError", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const otherService = await createService(org, actor, "req", { name: "Outro", durationMinutes: 30 });
  await assert.rejects(
    () => createAppointment(org, actor, "req", { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: otherService.id, startAt: at("09:00") }),
    NotFoundError,
  );
});

test("unknown Customer/Professional/Service ids -> NotFoundError", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const input = { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, startAt: at("09:00") };
  for (const key of ["customerId", "professionalId", "serviceId"] as const) {
    await assert.rejects(() => createAppointment(org, actor, "req", { ...input, [key]: randomUUID() }), NotFoundError, key);
  }
});

// ======================= ARCHIVED RESOURCES =======================

test("archived Professional: new booking rejected; existing appointment untouched and still cancelable; reschedule rejected", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const existing = await book(org, seed, at("09:00"));
  const existing2 = await book(org, seed, at("11:00"));
  await updateProfessionalOrThrow(org, actor, "req", seed.professional.id, { status: "ARCHIVED" });

  await assert.rejects(() => book(org, seed, at("14:00")), ProfessionalArchivedError);
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", existing.id, { startAt: at("15:00") }), ProfessionalArchivedError);
  assert.equal((await getAppointmentOrThrow(org, existing.id)).status, "SCHEDULED", "archiving never alters existing appointments");
  assert.equal((await cancelAppointment(org, actor, "req", existing2.id, {})).status, "CANCELED");
});

test("reschedule to ANOTHER archived Professional is rejected; to an active associated one succeeds", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  const archived = await addProfessional(org, seed.service.id);
  await updateProfessionalOrThrow(org, actor, "req", archived.id, { status: "ARCHIVED" });
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { professionalId: archived.id }), ProfessionalArchivedError);

  const active = await addProfessional(org, seed.service.id);
  const moved = await updateAppointmentOrThrow(org, actor, "req", appointment.id, { professionalId: active.id });
  assert.equal(moved.professionalId, active.id);
  assert.equal(moved.customerId, seed.customer.id, "customer never changes");
});

test("archived Service: new booking rejected; reschedule rejected; existing appointment intact and completable", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const past = at("09:00", addDays(toLocal(new Date(), TZ).date, -1));
  const pastAppointment = await book(org, seed, past, { now: new Date(past.getTime() - 86_400_000) });
  const future = await book(org, seed, at("09:00"));
  await updateServiceOrThrow(org, actor, "req", seed.service.id, { status: "ARCHIVED" });

  await assert.rejects(() => book(org, seed, at("14:00")), ServiceArchivedError);
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", future.id, { startAt: at("15:00") }), ServiceArchivedError);
  assert.equal((await getAppointmentOrThrow(org, future.id)).serviceName, "Personal Training");
  assert.equal((await completeAppointment(org, actor, "req", pastAppointment.id)).status, "COMPLETED");
});

test("archived Customer: new booking and reschedule rejected; cancel still allowed; history intact", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  await archiveCustomer(org, actor, "req", seed.customer.id);
  await assert.rejects(() => book(org, seed, at("14:00")), CustomerArchivedError);
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: at("15:00") }), CustomerArchivedError);
  assert.equal((await cancelAppointment(org, actor, "req", appointment.id, { reason: "Cliente saiu" })).status, "CANCELED");
});

test("removed professional_services association: new booking -> NotFoundError; existing appointment untouched", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const existing = await book(org, seed, at("09:00"));
  await removeAssociation(org, actor, "req", seed.professional.id, seed.service.id);
  await assert.rejects(() => book(org, seed, at("14:00")), NotFoundError);
  assert.equal((await getAppointmentOrThrow(org, existing.id)).status, "SCHEDULED");
});

// ======================= CONFLICT CONSTRAINT (sequential semantics) =======================

test("constraint: identical and partially-overlapping bookings -> AppointmentConflictError; adjacent [start,end) bookings succeed", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  await book(org, seed, at("10:00"));
  await assert.rejects(() => book(org, seed, at("10:00")), AppointmentConflictError);
  await assert.rejects(() => book(org, seed, at("10:30")), AppointmentConflictError);
  await assert.rejects(() => book(org, seed, at("09:30")), AppointmentConflictError);
  await book(org, seed, at("11:00"));
  await book(org, seed, at("09:00"));
  assert.equal((await occupyingRows(org, seed.professional.id)).length, 3);
});

test("constraint: a CANCELED appointment releases its interval; a COMPLETED one keeps blocking", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("10:00"));
  await cancelAppointment(org, actor, "req", a.id, {});
  const b = await book(org, seed, at("10:00"));
  assert.equal(b.status, "SCHEDULED", "canceled did not block");

  const pastDate = addDays(toLocal(new Date(), TZ).date, -1);
  const oldNow = new Date(at("09:00", pastDate).getTime() - 86_400_000);
  const done = await book(org, seed, at("09:00", pastDate), { now: oldNow });
  await completeAppointment(org, actor, "req", done.id);
  await assert.rejects(() => book(org, seed, at("09:00", pastDate), { now: oldNow }), AppointmentConflictError, "completed still occupies");
});

test("constraint: different Professionals and different organizations never conflict", async () => {
  const orgA = await seedOrg();
  const orgB = await seedOrg();
  const a = await seedBookable(orgA);
  const b = await seedBookable(orgB);
  const a2 = await addProfessional(orgA, a.service.id);
  await book(orgA, a, at("10:00"));
  await book(orgA, a, at("10:00"), { professionalId: a2.id });
  await book(orgB, b, at("10:00"));
});

test("error mapping: the conflict error exposes no constraint name, SQL or driver text", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  await book(org, seed, at("10:00"));
  const err = await book(org, seed, at("10:00")).catch((e) => e);
  assert.ok(err instanceof AppointmentConflictError);
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, "APPOINTMENT_CONFLICT");
  assert.doesNotMatch(err.message, /appointments_professional_no_overlap|exclusion|23P01|insert|select/i);
});

// ======================= RESCHEDULING =======================

test("reschedule: moves the SAME row, preserves customer/service/snapshots/duration even after the Service duration changed", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  await updateServiceOrThrow(org, actor, "req", seed.service.id, { durationMinutes: 90, price: "99.00" });
  const moved = await updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: at("14:00") });
  assert.equal(moved.id, appointment.id);
  assert.equal(moved.startAt.toISOString(), at("14:00").toISOString());
  assert.equal(moved.durationMinutes, 60, "duration preserved from the appointment, never re-read from the Service");
  assert.equal(moved.servicePrice, "10000.00");
  assert.equal(moved.customerId, seed.customer.id);
});

test("reschedule: overlapping its OWN previous interval is fine (09:00-10:00 -> 09:30-10:30) — no self-conflict", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  const moved = await updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: at("09:30") });
  assert.equal(moved.startAt.toISOString(), at("09:30").toISOString());
});

test("reschedule: into another appointment's interval -> AppointmentConflictError, and the row is left unchanged", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  await book(org, seed, at("12:00"));
  const appointment = await book(org, seed, at("09:00"));
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: at("12:30") }), AppointmentConflictError);
  assert.equal((await getAppointmentOrThrow(org, appointment.id)).startAt.toISOString(), at("09:00").toISOString());
});

test("reschedule: outside availability / beyond horizon rejected; terminal appointments cannot be rescheduled or edited", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: at("20:00") }), AppointmentOutsideAvailabilityError);
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: new Date(Date.now() + 400 * 86_400_000) }), BookingHorizonExceededError);
  await cancelAppointment(org, actor, "req", appointment.id, {});
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { startAt: at("14:00") }), InvalidAppointmentStateError);
  await assert.rejects(() => updateAppointmentOrThrow(org, actor, "req", appointment.id, { notes: "x" }), InvalidAppointmentStateError);
});

test("notes: set, clear (null), and a notes-only edit skips availability entirely (still allowed)", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  assert.equal((await updateAppointmentOrThrow(org, actor, "req", appointment.id, { notes: "Traz toalha" })).notes, "Traz toalha");
  assert.equal((await updateAppointmentOrThrow(org, actor, "req", appointment.id, { notes: null })).notes, null);
});

// ======================= CANCEL / COMPLETE =======================

test("cancel: SCHEDULED -> CANCELED with canceled_at and reason; terminal — second cancel / un-cancel impossible", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  const canceled = await cancelAppointment(org, actor, "req", appointment.id, { reason: "Pedido do cliente" });
  assert.equal(canceled.status, "CANCELED");
  assert.equal(canceled.cancellationReason, "Pedido do cliente");
  assert.ok(canceled.canceledAt instanceof Date);
  await assert.rejects(() => cancelAppointment(org, actor, "req", appointment.id, {}), InvalidAppointmentStateError);
  await assert.rejects(() => completeAppointment(org, actor, "req", appointment.id, { now: new Date(Date.now() + 30 * 86_400_000) }), InvalidAppointmentStateError);
});

test("complete: before start_at -> AppointmentCompletionTooEarlyError; at/after start -> COMPLETED (terminal)", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const appointment = await book(org, seed, at("09:00"));
  await assert.rejects(() => completeAppointment(org, actor, "req", appointment.id), AppointmentCompletionTooEarlyError);
  const completed = await completeAppointment(org, actor, "req", appointment.id, { now: at("09:00") });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.completedAt!.toISOString(), at("09:00").toISOString());
  await assert.rejects(() => cancelAppointment(org, actor, "req", appointment.id, {}), InvalidAppointmentStateError);
});

// ======================= TENANT ISOLATION =======================

test("tenant isolation: org B cannot book with org A's Customer/Professional/Service, nor read/reschedule/cancel/complete org A's appointment", async () => {
  const orgA = await seedOrg();
  const orgB = await seedOrg();
  const a = await seedBookable(orgA);
  const b = await seedBookable(orgB);
  const appointment = await book(orgA, a, at("09:00"));

  const base = { customerId: b.customer.id, professionalId: b.professional.id, serviceId: b.service.id, startAt: at("09:00") };
  await assert.rejects(() => createAppointment(orgB, actor, "req", { ...base, customerId: a.customer.id }), NotFoundError);
  await assert.rejects(() => createAppointment(orgB, actor, "req", { ...base, professionalId: a.professional.id }), NotFoundError);
  await assert.rejects(() => createAppointment(orgB, actor, "req", { ...base, serviceId: a.service.id }), NotFoundError);

  await assert.rejects(() => getAppointmentOrThrow(orgB, appointment.id), AppointmentNotFoundError);
  await assert.rejects(() => updateAppointmentOrThrow(orgB, actor, "req", appointment.id, { startAt: at("14:00") }), AppointmentNotFoundError);
  await assert.rejects(() => updateAppointmentOrThrow(orgB, actor, "req", appointment.id, { notes: "x" }), AppointmentNotFoundError);
  await assert.rejects(() => cancelAppointment(orgB, actor, "req", appointment.id, {}), AppointmentNotFoundError);
  await assert.rejects(() => completeAppointment(orgB, actor, "req", appointment.id, { now: at("12:00") }), AppointmentNotFoundError);
  await assert.rejects(() => getBookableSlotsOrThrow(orgB, a.professional.id, { date: DAY, serviceId: a.service.id }), NotFoundError);

  const listedByB = await listAppointmentsOrThrow(orgB, { from: DAY, to: DAY, limit: 200 });
  assert.ok(!listedByB.some((row) => row.id === appointment.id));
  assert.equal((await getAppointmentOrThrow(orgA, appointment.id)).status, "SCHEDULED", "nothing org B tried changed it");
});

// ======================= LISTING / BOOKABLE SLOTS =======================

test("list: window in organization-local dates, overlap semantics, filters, deterministic ordering, canceled included unless filtered", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const other = await addProfessional(org, seed.service.id);
  const x = await book(org, seed, at("11:00"));
  const y = await book(org, seed, at("09:00"));
  const z = await book(org, seed, at("09:00"), { professionalId: other.id });
  const nextDay = await book(org, seed, at("09:00", addDays(DAY, 1)));
  await cancelAppointment(org, actor, "req", x.id, {});

  const day = await listAppointmentsOrThrow(org, { from: DAY, to: DAY, limit: 200 });
  assert.deepEqual(new Set(day.map((row) => row.id)), new Set([x.id, y.id, z.id]));
  assert.ok(day[0]!.startAt <= day[1]!.startAt && day[1]!.startAt <= day[2]!.startAt, "ordered by start_at");
  assert.ok(!day.some((row) => row.id === nextDay.id));

  assert.deepEqual((await listAppointmentsOrThrow(org, { from: DAY, to: DAY, professionalId: other.id, limit: 200 })).map((row) => row.id), [z.id]);
  assert.deepEqual((await listAppointmentsOrThrow(org, { from: DAY, to: DAY, status: "CANCELED", limit: 200 })).map((row) => row.id), [x.id]);
  assert.equal((await listAppointmentsOrThrow(org, { from: DAY, to: addDays(DAY, 1), customerId: seed.customer.id, serviceId: seed.service.id, limit: 200 })).length, 4);
  assert.equal((await listAppointmentsOrThrow(org, { from: DAY, to: addDays(DAY, 1), limit: 2 })).length, 2, "limit applied");
});

test("list: requires a configured timezone", async () => {
  const org = await seedOrg(null);
  await assert.rejects(() => listAppointmentsOrThrow(org, { from: DAY, to: DAY, limit: 200 }), TimezoneNotConfiguredError);
});

test("bookable slots: F26 start times minus occupying appointments; canceled ones do not remove slots; absolute instants returned", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const booked = await book(org, seed, at("10:00"));
  const canceled = await book(org, seed, at("14:00"));
  await cancelAppointment(org, actor, "req", canceled.id, {});

  const result = await getBookableSlotsOrThrow(org, seed.professional.id, { date: DAY, serviceId: seed.service.id });
  assert.equal(result.timezone, TZ);
  assert.equal(result.durationMinutes, 60);
  const times = result.slots.map((slot) => slot.localStartTime);
  for (const blocked of ["09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45"]) assert.ok(!times.includes(blocked), `${blocked} overlaps ${booked.id}`);
  for (const free of ["08:00", "09:00", "11:00", "14:00", "17:00"]) assert.ok(times.includes(free), `${free} should be bookable`);
  assert.equal(result.slots.find((slot) => slot.localStartTime === "09:00")!.startAt.toISOString(), at("09:00").toISOString());
});

test("bookable slots: archived Professional/Service -> 409s, not associated -> 404, no timezone -> 409", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const unassociated = await createService(org, actor, "req", { name: "Outro", durationMinutes: 30 });
  await assert.rejects(() => getBookableSlotsOrThrow(org, seed.professional.id, { date: DAY, serviceId: unassociated.id }), NotFoundError);
  await updateServiceOrThrow(org, actor, "req", seed.service.id, { status: "ARCHIVED" });
  await assert.rejects(() => getBookableSlotsOrThrow(org, seed.professional.id, { date: DAY, serviceId: seed.service.id }), ServiceArchivedError);
  await updateProfessionalOrThrow(org, actor, "req", seed.professional.id, { status: "ARCHIVED" });
  await assert.rejects(() => getBookableSlotsOrThrow(org, seed.professional.id, { date: DAY, serviceId: seed.service.id }), ProfessionalArchivedError);

  const noTz = await seedOrg(null);
  const s2 = await seedBookable(noTz);
  await assert.rejects(() => getBookableSlotsOrThrow(noTz, s2.professional.id, { date: DAY, serviceId: s2.service.id }), TimezoneNotConfiguredError);
});

// ======================= AUDIT / USAGE =======================

test("audit: created / rescheduled / updated / canceled / completed — one row each, in-transaction, with the request id", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await createAppointment(org, actor, "req-created", { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, startAt: at("09:00") });
  await updateAppointmentOrThrow(org, actor, "req-rescheduled", a.id, { startAt: at("10:00") });
  await updateAppointmentOrThrow(org, actor, "req-updated", a.id, { notes: "nota" });
  await completeAppointment(org, actor, "req-completed", a.id, { now: at("10:00") });
  const b = await book(org, seed, at("15:00"));
  await cancelAppointment(org, actor, "req-canceled", b.id, { reason: "x" });

  const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, org.organizationId), eq(auditEvents.resourceType, "appointment")));
  const byAction = (action: string) => rows.filter((row) => row.action === action);
  assert.equal(byAction("appointment.created").length, 2);
  assert.equal(byAction("appointment.rescheduled")[0]!.requestId, "req-rescheduled");
  assert.deepEqual((byAction("appointment.rescheduled")[0]!.metadata as { from: { startAt: string } }).from.startAt, at("09:00").toISOString());
  assert.equal(byAction("appointment.updated").length, 1);
  assert.doesNotMatch(JSON.stringify(byAction("appointment.updated")[0]!.metadata), /nota/, "note text never copied into audit");
  assert.equal(byAction("appointment.completed")[0]!.requestId, "req-completed");
  assert.equal(byAction("appointment.canceled")[0]!.resourceId, b.id);
});

test("audit rollback: a failing audit insert rolls back the appointment insert (same transaction)", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const startAt = at("16:00");
  await assert.rejects(() =>
    db.transaction(async (tx) => {
      await insertAppointment(org, { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, startAt, endAt: at("17:00"), serviceName: "x", servicePrice: null, currency: "AOA", notes: null }, tx);
      // @ts-expect-error deliberately violating audit_events.action NOT NULL to prove rollback
      await recordAuditEvent({ organizationId: org.organizationId, actorType: "user", actorId: "t", action: null, resourceType: "appointment", resourceId: randomUUID() }, tx);
    }),
  );
  assert.equal((await occupyingRows(org, seed.professional.id)).length, 0);
  await book(org, seed, startAt); // the interval is genuinely free — nothing leaked
});

test("audit + usage on conflict: the losing write leaves NO audit row and records NO usage", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const winnerUsage = await countUsageCalls(org.organizationId, () => book(org, seed, at("10:00")));
  const loserUsage = await countUsageCalls(org.organizationId, () => book(org, seed, at("10:00")));
  assert.equal(winnerUsage, 1, "usage recorded once, after commit");
  assert.equal(loserUsage, 0, "failed transaction -> no usage");
  const created = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, org.organizationId), eq(auditEvents.action, "appointment.created")));
  assert.equal(created.length, 1);
});

test("usage: reschedule/cancel/complete record usage; notes-only edits and validation failures do not", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("09:00"));
  assert.equal(await countUsageCalls(org.organizationId, () => updateAppointmentOrThrow(org, actor, "req", a.id, { startAt: at("10:00") })), 1);
  assert.equal(await countUsageCalls(org.organizationId, () => updateAppointmentOrThrow(org, actor, "req", a.id, { notes: "x" })), 0);
  assert.equal(await countUsageCalls(org.organizationId, () => completeAppointment(org, actor, "req", a.id)), 0, "too early -> no usage");
  assert.equal(await countUsageCalls(org.organizationId, () => completeAppointment(org, actor, "req", a.id, { now: at("10:00") })), 1);
  const b = await book(org, seed, at("15:00"));
  assert.equal(await countUsageCalls(org.organizationId, () => cancelAppointment(org, actor, "req", b.id, {})), 1);
  assert.equal(await countUsageCalls(org.organizationId, () => book(org, seed, at("07:00"))), 0, "outside availability -> no usage");
});

// ======================= CONCURRENCY (real, simultaneous) =======================

test("CONCURRENCY proof of blocking: a second writer WAITS on the first's uncommitted overlapping row, then fails with APPOINTMENT_CONFLICT once it commits", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const startAt = at("10:00");
  let releaseFirst!: () => void;
  const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
  let signalInserted!: () => void;
  const firstInserted = new Promise<void>((resolve) => (signalInserted = resolve));

  const first = db.transaction(async (tx) => {
    await insertAppointment(org, { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, startAt, endAt: at("11:00"), serviceName: "x", servicePrice: null, currency: "AOA", notes: null }, tx);
    signalInserted();
    await firstMayCommit;
  });
  await firstInserted;

  let secondSettled = false;
  const second = book(org, seed, at("10:30")).finally(() => (secondSettled = true));

  // Wait until Postgres itself reports a backend blocked on a lock while inserting into appointments.
  let observedWaiting = false;
  for (let i = 0; i < 100 && !observedWaiting; i++) {
    const rows = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%insert into "na_pista"."appointments"%'`,
    );
    observedWaiting = rows[0]!.n > 0;
    if (!observedWaiting) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(observedWaiting, true, "the second insert must be observed WAITING on the first transaction's lock");
  assert.equal(secondSettled, false, "and must not have completed while the first is uncommitted");

  releaseFirst();
  await first;
  await assert.rejects(second, AppointmentConflictError);
  assert.equal((await occupyingRows(org, seed.professional.id)).length, 1);
});

test("CONCURRENCY proof of blocking (rollback branch): if the first writer rolls back, the waiting writer SUCCEEDS", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve));
  let signalInserted!: () => void;
  const firstInserted = new Promise<void>((resolve) => (signalInserted = resolve));

  const first = db
    .transaction(async (tx) => {
      await insertAppointment(org, { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, startAt: at("10:00"), endAt: at("11:00"), serviceName: "x", servicePrice: null, currency: "AOA", notes: null }, tx);
      signalInserted();
      await firstMayFinish;
      throw new Error("deliberate rollback");
    })
    .catch((error) => error);
  await firstInserted;
  const second = book(org, seed, at("10:00"));

  for (let i = 0; i < 100; i++) {
    const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%insert into "na_pista"."appointments"%'`);
    if (rows[0]!.n > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  releaseFirst();
  await first;
  const created = await second;
  assert.equal(created.status, "SCHEDULED");
});

test("CONCURRENCY case 1: two simultaneous identical bookings -> exactly 1 success, 1 APPOINTMENT_CONFLICT", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const { fulfilled, rejected } = split(await Promise.allSettled([book(org, seed, at("10:00")), book(org, seed, at("10:00"))]));
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0] instanceof AppointmentConflictError);
  assert.equal((await occupyingRows(org, seed.professional.id)).length, 1);
});

test("CONCURRENCY case 2: two simultaneous partially-overlapping bookings (10:00-11:00 vs 10:30-11:30) -> exactly 1 success", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const { fulfilled, rejected } = split(await Promise.allSettled([book(org, seed, at("10:00")), book(org, seed, at("10:30"))]));
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] instanceof AppointmentConflictError);
  assertNoOverlap(await occupyingRows(org, seed.professional.id));
});

test("CONCURRENCY case 3: simultaneous back-to-back bookings (10:00-11:00 and 11:00-12:00) -> both succeed", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const { fulfilled } = split(await Promise.allSettled([book(org, seed, at("10:00")), book(org, seed, at("11:00"))]));
  assert.equal(fulfilled.length, 2);
});

test("CONCURRENCY case 4: simultaneous same-interval bookings for DIFFERENT Professionals -> both succeed", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const other = await addProfessional(org, seed.service.id);
  const { fulfilled } = split(await Promise.allSettled([book(org, seed, at("10:00")), book(org, seed, at("10:00"), { professionalId: other.id })]));
  assert.equal(fulfilled.length, 2);
});

test("CONCURRENCY case 5: simultaneous same-interval bookings in DIFFERENT organizations -> both succeed", async () => {
  const orgA = await seedOrg();
  const orgB = await seedOrg();
  const a = await seedBookable(orgA);
  const b = await seedBookable(orgB);
  const { fulfilled } = split(await Promise.allSettled([book(orgA, a, at("10:00")), book(orgB, b, at("10:00"))]));
  assert.equal(fulfilled.length, 2);
});

test("CONCURRENCY case 6: a canceled appointment releases its interval — simultaneous re-bookings of it -> exactly 1 success", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const original = await book(org, seed, at("10:00"));
  await cancelAppointment(org, actor, "req", original.id, {});
  const { fulfilled, rejected } = split(await Promise.allSettled([book(org, seed, at("10:00")), book(org, seed, at("10:00"))]));
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] instanceof AppointmentConflictError);
});

test("CONCURRENCY case 7: a COMPLETED appointment keeps blocking — simultaneous bookings over it all fail", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const pastDate = addDays(toLocal(new Date(), TZ).date, -1);
  const oldNow = new Date(at("09:00", pastDate).getTime() - 86_400_000);
  const done = await book(org, seed, at("09:00", pastDate), { now: oldNow });
  await completeAppointment(org, actor, "req", done.id);
  const { fulfilled, rejected } = split(await Promise.allSettled([book(org, seed, at("09:00", pastDate), { now: oldNow }), book(org, seed, at("09:30", pastDate), { now: oldNow })]));
  assert.equal(fulfilled.length, 0);
  assert.ok(rejected.every((error) => error instanceof AppointmentConflictError));
});

test("CONCURRENCY case 8: two DIFFERENT appointments simultaneously rescheduled to the same target -> exactly 1 success; the loser is unchanged", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("09:00"));
  const b = await book(org, seed, at("11:00"));
  const { fulfilled, rejected } = split(
    await Promise.allSettled([
      updateAppointmentOrThrow(org, actor, "req-a", a.id, { startAt: at("14:00") }),
      updateAppointmentOrThrow(org, actor, "req-b", b.id, { startAt: at("14:00") }),
    ]),
  );
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] instanceof AppointmentConflictError);
  const loserId = fulfilled[0]!.id === a.id ? b.id : a.id;
  const loserOriginal = loserId === a.id ? at("09:00") : at("11:00");
  assert.equal((await getAppointmentOrThrow(org, loserId)).startAt.toISOString(), loserOriginal.toISOString());
  assertNoOverlap(await occupyingRows(org, seed.professional.id));
});

test("CONCURRENCY case 9: a reschedule and a new booking simultaneously targeting the same interval -> exactly 1 success", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("09:00"));
  const { fulfilled, rejected } = split(await Promise.allSettled([updateAppointmentOrThrow(org, actor, "req", a.id, { startAt: at("14:00") }), book(org, seed, at("14:30"))]));
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] instanceof AppointmentConflictError);
  assertNoOverlap(await occupyingRows(org, seed.professional.id));
});

test("CONCURRENCY case 10: cancel of A racing a new booking over A's interval — A always ends CANCELED; the booking wins only if the cancel committed first; never two occupying overlaps", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const outcomes = { bookingWon: 0, bookingLost: 0 };
  for (const time of ["08:00", "10:00", "12:00", "14:00", "16:00"]) {
    const a = await book(org, seed, at(time));
    const [cancelResult, bookResult] = await Promise.allSettled([cancelAppointment(org, actor, "req", a.id, {}), book(org, seed, at(time))]);
    assert.equal(cancelResult.status, "fulfilled", "the cancel itself never fails");
    if (bookResult.status === "fulfilled") outcomes.bookingWon++;
    else {
      assert.ok(bookResult.reason instanceof AppointmentConflictError, "the only acceptable failure is the conflict error");
      outcomes.bookingLost++;
    }
    assert.equal((await getAppointmentOrThrow(org, a.id)).status, "CANCELED");
  }
  assertNoOverlap(await occupyingRows(org, seed.professional.id));
  assert.equal(outcomes.bookingWon + outcomes.bookingLost, 5);
  console.log(JSON.stringify({ event: "f27.concurrency.case10", ...outcomes }));
});

test("CONCURRENCY case 11: two simultaneous completions -> exactly 1 COMPLETED, the other INVALID_APPOINTMENT_STATE", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("09:00"));
  const now = at("09:30");
  const { fulfilled, rejected } = split(await Promise.allSettled([completeAppointment(org, actor, "r1", a.id, { now }), completeAppointment(org, actor, "r2", a.id, { now })]));
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] instanceof InvalidAppointmentStateError);
  const completedAudits = await db.select().from(auditEvents).where(and(eq(auditEvents.resourceId, a.id), eq(auditEvents.action, "appointment.completed")));
  assert.equal(completedAudits.length, 1, "exactly one completion was applied");
});

test("CONCURRENCY case 12a: two simultaneous reschedules of the SAME appointment (-> 12:00 and -> 12:30) are serialized by the row lock — consistent final state, duration intact", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("10:00"));
  const { fulfilled, rejected } = split(
    await Promise.allSettled([updateAppointmentOrThrow(org, actor, "r1", a.id, { startAt: at("12:00") }), updateAppointmentOrThrow(org, actor, "r2", a.id, { startAt: at("12:30") })]),
  );
  assert.equal(fulfilled.length + rejected.length, 2);
  assert.equal(rejected.length, 0, "both are valid moves of the same row; the lock makes them apply one after the other");
  const final = await getAppointmentOrThrow(org, a.id);
  assert.ok([at("12:00").toISOString(), at("12:30").toISOString()].includes(final.startAt.toISOString()));
  assert.equal(final.durationMinutes, 60);
  const rescheduled = await db.select().from(auditEvents).where(and(eq(auditEvents.resourceId, a.id), eq(auditEvents.action, "appointment.rescheduled")));
  assert.equal(rescheduled.length, 2);
  assert.equal(
    (rescheduled.map((row) => row.metadata as { to: { startAt: string } }).find((m) => m.to.startAt === final.startAt.toISOString()) !== undefined),
    true,
    "the last applied reschedule is the one the row reflects",
  );
});

test("CONCURRENCY case 12b: a reschedule racing a cancel of the SAME appointment — whichever locks first wins; the other sees the real state", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("10:00"));
  const [rescheduleResult, cancelResult] = await Promise.allSettled([updateAppointmentOrThrow(org, actor, "r1", a.id, { startAt: at("15:00") }), cancelAppointment(org, actor, "r2", a.id, {})]);
  assert.equal(cancelResult.status, "fulfilled", "cancel is valid whether it runs before or after the reschedule");
  if (rescheduleResult.status === "rejected") assert.ok(rescheduleResult.reason instanceof InvalidAppointmentStateError);
  const final = await getAppointmentOrThrow(org, a.id);
  assert.equal(final.status, "CANCELED");
  assert.equal(final.durationMinutes, 60);
});

test("CONCURRENCY fan-out: 5 simultaneous bookings of the same slot -> exactly 1 success, 4 conflicts", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const { fulfilled, rejected } = split(await Promise.allSettled(Array.from({ length: 5 }, () => book(org, seed, at("13:00")))));
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every((error) => error instanceof AppointmentConflictError));
  assert.equal((await occupyingRows(org, seed.professional.id)).length, 1);
});

test("CONCURRENCY advisory vs authoritative: both callers see the slot as bookable, both book simultaneously -> the database picks exactly one", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const [viewA, viewB] = await Promise.all([
    getBookableSlotsOrThrow(org, seed.professional.id, { date: DAY, serviceId: seed.service.id }),
    getBookableSlotsOrThrow(org, seed.professional.id, { date: DAY, serviceId: seed.service.id }),
  ]);
  const slotA = viewA.slots.find((slot) => slot.localStartTime === "15:00")!;
  const slotB = viewB.slots.find((slot) => slot.localStartTime === "15:00")!;
  assert.ok(slotA && slotB, "both clients were told 15:00 is bookable");
  const { fulfilled, rejected } = split(await Promise.allSettled([book(org, seed, slotA.startAt), book(org, seed, slotB.startAt)]));
  assert.equal(fulfilled.length, 1);
  assert.ok(rejected[0] instanceof AppointmentConflictError);
});

test("CONCURRENCY conflict bypass attempt: a raw UPDATE un-canceling into an occupied interval is rejected by Postgres itself", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const a = await book(org, seed, at("10:00"));
  await cancelAppointment(org, actor, "req", a.id, {});
  await book(org, seed, at("10:00"));
  const err = await db
    .update(appointments)
    .set({ status: "SCHEDULED", canceledAt: null })
    .where(eq(appointments.id, a.id))
    .catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal((err.cause as { code?: string }).code, "23P01");
});

// ======================= DEADLOCK MAPPING (found during F27) =======================

test("error mapping: 23P01 on the no-overlap constraint AND 40P01 deadlock on the guarded write both become APPOINTMENT_CONFLICT; anything else passes through untouched", () => {
  const wrap = (code: string, constraint_name?: string) => Object.assign(new Error("Failed query: insert ..."), { cause: Object.assign(new Error("driver"), { code, constraint_name }) });
  assert.ok(mapBookingWriteError(wrap("23P01", NO_OVERLAP_CONSTRAINT)) instanceof AppointmentConflictError);
  assert.ok(mapBookingWriteError(wrap("40P01")) instanceof AppointmentConflictError);
  const other = wrap("23505", "x");
  assert.equal(mapBookingWriteError(other), other);
  const unrelatedExclusion = wrap("23P01", "some_future_constraint");
  assert.equal(mapBookingWriteError(unrelatedExclusion), unrelatedExclusion, "only OUR constraint means a booking conflict");
});

test("CONCURRENCY stress (regression for the F27 deadlock finding): 20 rounds x 5 racing bookings — exactly one winner per round, EVERY loser is APPOINTMENT_CONFLICT (never a raw 40P01/500)", async () => {
  const org = await seedOrg();
  const seed = await seedBookable(org);
  const losers: unknown[] = [];
  for (let round = 0; round < 20; round++) {
    const time = `${String(8 + Math.floor(round / 2)).padStart(2, "0")}:00`; // 08:00..17:00, two dates alternating — never overlapping each other
    const date = addDays(DAY, 3 + (round % 2));
    const { fulfilled, rejected } = split(await Promise.allSettled(Array.from({ length: 5 }, () => book(org, seed, at(time, date)))));
    assert.equal(fulfilled.length, 1, `round ${round}: exactly one winner`);
    losers.push(...rejected);
  }
  const unexpected = losers.filter((error) => !(error instanceof AppointmentConflictError));
  assert.deepEqual(unexpected.map((error) => String((error as Error).message).slice(0, 80)), []);
  assertNoOverlap(await occupyingRows(org, seed.professional.id));
});
