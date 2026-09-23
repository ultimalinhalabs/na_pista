import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { organizationSettings, professionalScheduleExceptions, professionalScheduleRules } from "../../src/db/schema/index.js";
import { associateService, createProfessional, updateProfessionalOrThrow } from "../../src/modules/professionals/service.js";
import { insertService, updateService } from "../../src/modules/services/repository.js";
import { updateOrganizationSettings, getOrganizationSettingsOrNull, getTimezoneOrThrow } from "../../src/modules/organizationSettings/service.js";
import {
  createExceptionOrThrow,
  getAvailabilityOrThrow,
  getScheduleOrThrow,
  listExceptionsOrThrow,
  removeExceptionOrThrow,
  replaceScheduleOrThrow,
} from "../../src/modules/scheduling/service.js";
import { ConflictError, NotFoundError, ProfessionalArchivedError, ServiceArchivedError, TimezoneNotConfiguredError, ValidationError } from "../../src/shared/errors.js";

/** F26 brief §30 "Integration tests", real PostgreSQL, no HTTP, no Platform. */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };
const actor = { type: "user" as const, id: "test-actor" };

after(() => queryClient.end());

test("migration: organization_settings, professional_schedule_rules, professional_schedule_exceptions exist with the expected shape", async () => {
  assert.ok(Array.isArray(await db.select().from(organizationSettings).limit(1)));
  assert.ok(Array.isArray(await db.select().from(professionalScheduleRules).limit(1)));
  assert.ok(Array.isArray(await db.select().from(professionalScheduleExceptions).limit(1)));
});

// ---- organization_settings ----

test("organization settings: no row means not configured; PUT creates it; a second PUT updates it (upsert, not a duplicate)", async () => {
  const org = { organizationId: randomUUID() };
  assert.equal(await getOrganizationSettingsOrNull(org), null);

  const created = await updateOrganizationSettings(org, actor, "req-1", "Africa/Luanda");
  assert.equal(created.timezone, "Africa/Luanda");

  const updated = await updateOrganizationSettings(org, actor, "req-2", "Europe/Lisbon");
  assert.equal(updated.timezone, "Europe/Lisbon");

  const rows = await db.select().from(organizationSettings).where(eq(organizationSettings.organizationId, org.organizationId));
  assert.equal(rows.length, 1, "upsert replaces the single settings row, never a second one");
});

test("organization settings: getTimezoneOrThrow fails closed (TimezoneNotConfiguredError) when unset, succeeds once set", async () => {
  const org = { organizationId: randomUUID() };
  await assert.rejects(() => getTimezoneOrThrow(org), TimezoneNotConfiguredError);
  await updateOrganizationSettings(org, actor, "req-1", "Africa/Luanda");
  assert.equal(await getTimezoneOrThrow(org), "Africa/Luanda");
});

test("organization settings: tenant isolation — org B's settings are independent of org A's", async () => {
  await updateOrganizationSettings(orgA, actor, "req-1", "Africa/Luanda");
  assert.equal(await getOrganizationSettingsOrNull(orgB), null, "org B has no settings row just because org A set one");
});

test("organization settings audit: organization_settings.updated is recorded", async () => {
  const org = { organizationId: randomUUID() };
  const { auditEvents } = await import("../../src/db/schema/index.js");
  await updateOrganizationSettings(org, actor, "req-audit", "Africa/Luanda");
  const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, org.organizationId), eq(auditEvents.action, "organization_settings.updated")));
  assert.equal(rows.length, 1);
});

// ---- weekly schedule rules ----

async function seedProfessional(org: typeof orgA, name = "Profissional Agenda") {
  return createProfessional(org, actor, "req-seed", { name });
}

test("schedule: PUT with an empty array clears the schedule (closed every day, ADR-039 D33)", async () => {
  const professional = await seedProfessional(orgA);
  const saved = await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, []);
  assert.deepEqual(saved, []);
  assert.deepEqual(await getScheduleOrThrow(orgA, professional.id), []);
});

test("schedule: PUT persists multiple intervals per day, GET reflects them sorted", async () => {
  const professional = await seedProfessional(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [
    { dayOfWeek: 1, startLocalTime: "13:00", endLocalTime: "17:00" },
    { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
  ]);
  const rules = await getScheduleOrThrow(orgA, professional.id);
  assert.equal(rules.length, 2);
  assert.equal(rules[0]!.startLocalTime, "08:00", 'API/domain representation is "HH:mm" (ADR-040), never the raw Postgres "HH:mm:ss" round-trip');
  assert.equal(rules[1]!.startLocalTime, "13:00");
});

test("schedule: a second PUT atomically REPLACES the whole set — old rows gone, new rows present, nothing partial (ADR-039 D10)", async () => {
  const professional = await seedProfessional(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);
  await replaceScheduleOrThrow(orgA, actor, "req-2", professional.id, [{ dayOfWeek: 3, startLocalTime: "09:00", endLocalTime: "10:00" }]);

  const rules = await getScheduleOrThrow(orgA, professional.id);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.dayOfWeek, 3);
});

test("schedule: overlapping intervals on the same day are rejected — the WHOLE request fails, nothing is saved", async () => {
  const professional = await seedProfessional(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);

  await assert.rejects(
    () =>
      replaceScheduleOrThrow(orgA, actor, "req-2", professional.id, [
        { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
        { dayOfWeek: 1, startLocalTime: "11:00", endLocalTime: "14:00" },
      ]),
    ValidationError,
  );

  const rules = await getScheduleOrThrow(orgA, professional.id);
  assert.equal(rules.length, 1, "the rejected PUT left the previous schedule completely unchanged");
});

test("schedule: adjacent intervals (08:00-12:00, 12:00-17:00) are accepted, not merged (docs/f26-report.md §8)", async () => {
  const professional = await seedProfessional(orgA);
  const saved = await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [
    { dayOfWeek: 2, startLocalTime: "08:00", endLocalTime: "12:00" },
    { dayOfWeek: 2, startLocalTime: "12:00", endLocalTime: "17:00" },
  ]);
  assert.equal(saved.length, 2, "stored as two distinct rows, never merged into one 08:00-17:00 row");
});

test("schedule: cross-tenant composite FK rejects a raw insert of a rule against another org's Professional", async () => {
  const professionalInA = await seedProfessional(orgA, "Profissional A FK");
  const err = await db
    .insert(professionalScheduleRules)
    .values({ organizationId: orgB.organizationId, professionalId: professionalInA.id, dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" })
    .catch((e) => e);
  assert.ok(err instanceof Error);
  const cause = err.cause instanceof Error ? err.cause.message : String(err);
  assert.match(cause, /foreign key|violat/i);
  assert.match(cause, /professional_schedule_rules_professional_org_fk/);
});

test("schedule: the DB CHECK constraint itself rejects an overnight interval via a raw insert (end <= start), not just the Zod layer", async () => {
  const professional = await seedProfessional(orgA);
  const err = await db
    .insert(professionalScheduleRules)
    .values({ organizationId: orgA.organizationId, professionalId: professional.id, dayOfWeek: 1, startLocalTime: "22:00", endLocalTime: "02:00" })
    .catch((e) => e);
  assert.ok(err instanceof Error);
  const cause = err.cause instanceof Error ? err.cause.message : String(err);
  assert.match(cause, /professional_schedule_rules_end_after_start|violat/i);
});

test("schedule: nonexistent Professional resolves NotFoundError", async () => {
  await assert.rejects(() => replaceScheduleOrThrow(orgA, actor, "req-1", randomUUID(), []), NotFoundError);
  await assert.rejects(() => getScheduleOrThrow(orgA, randomUUID()), NotFoundError);
});

test("schedule: editing an ARCHIVED Professional's schedule IS allowed (mirrors updateProfessionalOrThrow's own posture — only availability READS are blocked for archived, not configuration, docs/f26-report.md §12)", async () => {
  const professional = await seedProfessional(orgA);
  await updateProfessionalOrThrow(orgA, actor, "req-archive", professional.id, { status: "ARCHIVED" });
  const saved = await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);
  assert.equal(saved.length, 1);
});

test("schedule tenant isolation: org B cannot read or replace org A's Professional's schedule", async () => {
  const professional = await seedProfessional(orgA, "Profissional Isolamento Agenda");
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);

  await assert.rejects(() => getScheduleOrThrow(orgB, professional.id), NotFoundError);
  await assert.rejects(() => replaceScheduleOrThrow(orgB, actor, "req-2", professional.id, []), NotFoundError);
});

test("schedule audit: schedule.updated is recorded on every PUT, in the same transaction", async () => {
  const { auditEvents } = await import("../../src/db/schema/index.js");
  const professional = await seedProfessional(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-audit", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);
  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.resourceId, professional.id), eq(auditEvents.action, "schedule.updated")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.requestId, "req-audit");
});

test("schedule audit-failure rollback: a real Postgres NOT NULL violation on audit_events.action rolls back the rule replacement", async () => {
  const { recordAuditEvent } = await import("../../src/modules/audit/service.js");
  const { replaceScheduleRules } = await import("../../src/modules/scheduling/repository.js");
  const professional = await seedProfessional(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        await replaceScheduleRules(orgA, professional.id, [{ dayOfWeek: 2, startLocalTime: "09:00", endLocalTime: "10:00" }], tx);
        await recordAuditEvent(
          {
            organizationId: orgA.organizationId,
            actorType: "user",
            actorId: "test-actor",
            // @ts-expect-error deliberately violating the NOT NULL constraint to prove rollback
            action: null,
            resourceType: "professional_schedule",
            resourceId: professional.id,
          },
          tx,
        );
      }),
    /audit_events/i,
  );

  const rules = await getScheduleOrThrow(orgA, professional.id);
  assert.equal(rules.length, 1, "the failed transaction never replaced the rule set — the original rule from req-1 is still exactly there");
  assert.equal(rules[0]!.dayOfWeek, 1);
});

// ---- schedule exceptions ----

test("exception: an interval exception can be created and listed", async () => {
  const professional = await seedProfessional(orgA);
  const created = await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });
  assert.equal(created.date, "2026-09-28");
  assert.equal(created.startLocalTime, "09:00");

  const list = await listExceptionsOrThrow(orgA, professional.id);
  assert.equal(list.length, 1);
});

test("exception: a closed-marker exception (fully unavailable) can be created", async () => {
  const professional = await seedProfessional(orgA);
  const created = await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-12-25" });
  assert.equal(created.startLocalTime, null);
  assert.equal(created.endLocalTime, null);
});

test("exception: a duplicate closed-marker for the same date fails with 409 CONFLICT (real DB unique violation on the partial index)", async () => {
  const professional = await seedProfessional(orgA);
  await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-12-25" });
  await assert.rejects(() => createExceptionOrThrow(orgA, actor, "req-2", professional.id, { date: "2026-12-25" }), ConflictError);
});

test("exception: an interval row cannot coexist with a closed-marker row for the same date, in either creation order", async () => {
  const professionalA = await seedProfessional(orgA, "Closed-then-interval");
  await createExceptionOrThrow(orgA, actor, "req-1", professionalA.id, { date: "2026-12-25" });
  await assert.rejects(
    () => createExceptionOrThrow(orgA, actor, "req-2", professionalA.id, { date: "2026-12-25", startLocalTime: "09:00", endLocalTime: "10:00" }),
    ConflictError,
  );

  const professionalB = await seedProfessional(orgA, "Interval-then-closed");
  await createExceptionOrThrow(orgA, actor, "req-1", professionalB.id, { date: "2026-12-25", startLocalTime: "09:00", endLocalTime: "10:00" });
  await assert.rejects(() => createExceptionOrThrow(orgA, actor, "req-2", professionalB.id, { date: "2026-12-25" }), ConflictError);
});

test("exception: overlapping interval exceptions on the same date are rejected", async () => {
  const professional = await seedProfessional(orgA);
  await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });
  await assert.rejects(
    () => createExceptionOrThrow(orgA, actor, "req-2", professional.id, { date: "2026-09-28", startLocalTime: "13:00", endLocalTime: "16:00" }),
    ValidationError,
  );
});

test("exception: multiple non-overlapping intervals on the same date are all accepted", async () => {
  const professional = await seedProfessional(orgA);
  await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "11:00" });
  await createExceptionOrThrow(orgA, actor, "req-2", professional.id, { date: "2026-09-28", startLocalTime: "14:00", endLocalTime: "16:00" });
  const list = await listExceptionsOrThrow(orgA, professional.id);
  assert.equal(list.length, 2);
});

test("exception: DELETE removes the row physically; a second removal returns 404 (idempotent-safety, never a silent no-op)", async () => {
  const professional = await seedProfessional(orgA);
  const created = await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });

  await removeExceptionOrThrow(orgA, actor, "req-2", professional.id, created.id);
  assert.deepEqual(await listExceptionsOrThrow(orgA, professional.id), []);

  await assert.rejects(() => removeExceptionOrThrow(orgA, actor, "req-3", professional.id, created.id), NotFoundError);
});

test("exception: removal is allowed even when the Professional is ARCHIVED (mirrors removeAssociation's posture)", async () => {
  const professional = await seedProfessional(orgA);
  const created = await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });
  await updateProfessionalOrThrow(orgA, actor, "req-archive", professional.id, { status: "ARCHIVED" });
  await removeExceptionOrThrow(orgA, actor, "req-2", professional.id, created.id);
  assert.deepEqual(await listExceptionsOrThrow(orgA, professional.id), []);
});

test("exception tenant isolation: org B cannot list, create, or remove exceptions for org A's Professional", async () => {
  const professional = await seedProfessional(orgA, "Profissional Isolamento Excecao");
  const created = await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });

  await assert.rejects(() => listExceptionsOrThrow(orgB, professional.id), NotFoundError);
  await assert.rejects(() => createExceptionOrThrow(orgB, actor, "req-2", professional.id, { date: "2026-10-01" }), NotFoundError);
  await assert.rejects(() => removeExceptionOrThrow(orgB, actor, "req-3", professional.id, created.id), NotFoundError);
});

test("exception audit: schedule.exception.created and schedule.exception.removed are recorded", async () => {
  const { auditEvents } = await import("../../src/db/schema/index.js");
  const professional = await seedProfessional(orgA);
  const created = await createExceptionOrThrow(orgA, actor, "req-1", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });

  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.resourceId, created.id), eq(auditEvents.action, "schedule.exception.created")));
  assert.equal(createdRows.length, 1);

  await removeExceptionOrThrow(orgA, actor, "req-2", professional.id, created.id);
  const removedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.resourceId, created.id), eq(auditEvents.action, "schedule.exception.removed")));
  assert.equal(removedRows.length, 1);
});

// ---- availability ----

async function seedProfessionalWithTimezone(org: typeof orgA, timezone = "Africa/Luanda") {
  const professional = await seedProfessional(org, `Profissional Disponibilidade ${randomUUID()}`);
  await updateOrganizationSettings(org, actor, "req-tz", timezone);
  return professional;
}

test("availability: fails closed with TimezoneNotConfiguredError when the organization has no timezone set", async () => {
  const org = { organizationId: randomUUID() };
  const professional = await seedProfessional(org);
  await assert.rejects(() => getAvailabilityOrThrow(org, professional.id, { from: "2026-09-28", to: "2026-09-28" }), TimezoneNotConfiguredError);
});

test("availability: reflects the weekly schedule for the requested range", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);

  const availability = await getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28" });
  assert.equal(availability.timezone, "Africa/Luanda");
  assert.equal(availability.days.length, 1);
  assert.deepEqual(availability.days[0]!.workingIntervals, [{ start: "08:00", end: "12:00" }]);
});

test("availability: an exception replaces the weekly schedule for its date, real rows read back", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);
  await createExceptionOrThrow(orgA, actor, "req-2", professional.id, { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" });

  const availability = await getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28" });
  assert.deepEqual(availability.days[0]!.workingIntervals, [{ start: "09:00", end: "14:00" }]);
});

test("availability: with a valid, associated, ACTIVE serviceId, serviceStartTimes are computed using Service.durationMinutes", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  const service = await insertService(orgA, { name: "Corte", durationMinutes: 60 });
  await associateService(orgA, actor, "req-assoc", professional.id, service.id);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "09:00" }]);

  const availability = await getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28", serviceId: service.id });
  assert.deepEqual(availability.days[0]!.serviceStartTimes, ["08:00"]);
});

test("availability: a nonexistent serviceId resolves NotFoundError", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  await assert.rejects(() => getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28", serviceId: randomUUID() }), NotFoundError);
});

test("availability: an ARCHIVED serviceId resolves ServiceArchivedError", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  const service = await insertService(orgA, { name: "Corte Arquivado", durationMinutes: 30 });
  await associateService(orgA, actor, "req-assoc", professional.id, service.id);
  await updateService(orgA, service.id, { status: "ARCHIVED" });

  await assert.rejects(() => getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28", serviceId: service.id }), ServiceArchivedError);
});

test("availability: a Service that exists but is NOT associated with this Professional resolves NotFoundError (never duplicates professional_services, always reads it live)", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  const unassociatedService = await insertService(orgA, { name: "Serviço Não Associado", durationMinutes: 30 });
  await assert.rejects(
    () => getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28", serviceId: unassociatedService.id }),
    NotFoundError,
  );
});

test("availability: an ARCHIVED Professional resolves ProfessionalArchivedError (availability reads are blocked, schedule rows are untouched)", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  await replaceScheduleOrThrow(orgA, actor, "req-1", professional.id, [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }]);
  await updateProfessionalOrThrow(orgA, actor, "req-archive", professional.id, { status: "ARCHIVED" });

  await assert.rejects(() => getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28" }), ProfessionalArchivedError);

  await updateProfessionalOrThrow(orgA, actor, "req-reactivate", professional.id, { status: "ACTIVE" });
  const availability = await getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28" });
  assert.deepEqual(availability.days[0]!.workingIntervals, [{ start: "08:00", end: "12:00" }], "reactivation restores availability for free — nothing was ever deleted");
});

test("availability tenant isolation: org B's Service/professional_services cannot satisfy org A's compatibility check", async () => {
  const professional = await seedProfessionalWithTimezone(orgA);
  const serviceInB = await insertService(orgB, { name: "Serviço B", durationMinutes: 30 });
  await assert.rejects(
    () => getAvailabilityOrThrow(orgA, professional.id, { from: "2026-09-28", to: "2026-09-28", serviceId: serviceInB.id }),
    NotFoundError,
  );
});
