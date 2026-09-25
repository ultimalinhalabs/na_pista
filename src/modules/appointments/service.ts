import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getCustomer } from "../customers/repository.js";
import { getAssociation, getProfessional } from "../professionals/repository.js";
import { getService } from "../services/repository.js";
import { getTimezoneOrThrow } from "../organizationSettings/service.js";
import { listScheduleExceptionsInRange, listScheduleRules } from "../scheduling/repository.js";
import {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentOutsideAvailabilityError,
  CustomerArchivedError,
  NotFoundError,
  ProfessionalArchivedError,
  ServiceArchivedError,
  isDeadlockError,
  isExclusionViolationError,
} from "../../shared/errors.js";
import { computeBookableSlots, isWithinAvailability, type ScheduleInput } from "./booking.js";
import { BOOKING_HORIZON_DAYS, assertTransition, assertWithinBookingWindow, type AppointmentStatus } from "./lifecycle.js";
import {
  getAppointment,
  getAppointmentForUpdate,
  insertAppointment,
  listAppointments,
  listOccupyingForProfessional,
  updateAppointment,
  type AppointmentRow,
  type TenantContext,
} from "./repository.js";
import { buildBookingSnapshot } from "./snapshot.js";
import { localDateWindow, minutesBetween, toLocal } from "./time.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

/**
 * The server clock is the only time source for lifecycle/horizon rules
 * (never browser time, never a client-supplied "now"). Routes never pass
 * this; tests pass a fixed `now` to make time-dependent rules
 * deterministic without faking the system clock.
 */
export interface ClockOptions {
  now?: Date;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The one constraint whose `23P01` means "booking conflict" (ADR-044). */
export const NO_OVERLAP_CONSTRAINT = "appointments_professional_no_overlap";

/** API representation (F27A §40): the row plus the derived, never-stored `durationMinutes = end_at - start_at`. */
export function toAppointmentDto(row: AppointmentRow) {
  return { ...row, durationMinutes: minutesBetween(row.startAt, row.endAt) };
}

/**
 * Translates the failure of the ONE write guarded by the no-overlap
 * constraint (the appointments INSERT, or the reschedule UPDATE):
 *  - `23P01` on `appointments_professional_no_overlap` -> APPOINTMENT_CONFLICT;
 *  - `40P01` deadlock_detected -> APPOINTMENT_CONFLICT as well. Found in
 *    F27 (docs/f27-report.md §17): an exclusion constraint inserts its index
 *    entry BEFORE checking, so two simultaneous overlapping writers can each
 *    wait on the other's uncommitted row; PostgreSQL's deadlock detector
 *    (after `deadlock_timeout`, 1s here) aborts one of them. Reproduced ~1 in
 *    125 racing writers on this database. The only waits this statement can
 *    have are on OVERLAPPING rows of the same Professional (the FK KEY SHARE
 *    locks never block other inserters), so a deadlock here means a
 *    concurrent overlapping booking was racing for the same interval — the
 *    same answer, and the same client action, as `23P01`. Still a single
 *    attempt: nothing is retried (ADR-044).
 * Raw Postgres text never leaves this function.
 */
export function mapBookingWriteError(error: unknown): unknown {
  if (isExclusionViolationError(error, NO_OVERLAP_CONSTRAINT) || isDeadlockError(error)) return new AppointmentConflictError();
  return error;
}

async function withConflictMapping<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw mapBookingWriteError(error);
  }
}

/** ADR-042: new bookings and reschedules require an ACTIVE Customer. Cancel/complete never call this. */
async function requireBookableCustomer(tenant: TenantContext, customerId: string, tx: Tx) {
  const customer = await getCustomer(tenant, customerId, tx);
  if (!customer) throw new NotFoundError("Customer not found");
  if (customer.status === "ARCHIVED") {
    throw new CustomerArchivedError(`Customer "${customer.name}" is archived; it cannot be booked`);
  }
  return customer;
}

/**
 * ADR-042: the Professional must be ACTIVE, the Service must be ACTIVE,
 * and the pair must be associated through `professional_services` (read
 * live, never duplicated). "Not associated" is a 404 NOT_FOUND exactly
 * like F26's availability endpoint — the existing convention for this
 * relationship (F27A §3).
 */
async function requireBookablePair(tenant: TenantContext, professionalId: string, serviceId: string, executor: Tx | typeof db) {
  const professional = await getProfessional(tenant, professionalId, executor);
  if (!professional) throw new NotFoundError("Professional not found");
  if (professional.status === "ARCHIVED") {
    throw new ProfessionalArchivedError(`Professional "${professional.name}" is archived; it cannot be booked`);
  }
  const service = await getService(tenant, serviceId, executor);
  if (!service) throw new NotFoundError("Service not found");
  if (service.status === "ARCHIVED") {
    throw new ServiceArchivedError(`Service "${service.name}" is archived; it cannot be booked`);
  }
  const association = await getAssociation(tenant, professionalId, serviceId, executor);
  if (!association) throw new NotFoundError(`Professional "${professional.name}" is not associated with service "${service.name}"`);
  return { professional, service };
}

/** Reads the Professional's schedule for ONE local date through F26's own repositories (executor-aware), shaped for F26's pure engine. */
async function loadSchedule(tenant: TenantContext, professionalId: string, date: string, executor: Tx | typeof db): Promise<ScheduleInput> {
  const [rules, exceptions] = await Promise.all([
    listScheduleRules(tenant, professionalId, executor),
    listScheduleExceptionsInRange(tenant, professionalId, date, date, executor),
  ]);
  return {
    rules: rules.map((row) => ({ dayOfWeek: row.dayOfWeek, startLocalTime: row.startLocalTime, endLocalTime: row.endLocalTime })),
    exceptions: exceptions.map((row) => ({ date: row.date, startLocalTime: row.startLocalTime, endLocalTime: row.endLocalTime })),
  };
}

/** Strict availability (F27A §17/§18): the start must be one of F26's `serviceStartTimes` for its local date, for this exact duration. Advisory input only — never the conflict guarantee. */
async function requireWithinAvailability(tenant: TenantContext, professionalId: string, startAt: Date, durationMinutes: number, timeZone: string, tx: Tx) {
  const schedule = await loadSchedule(tenant, professionalId, toLocal(startAt, timeZone).date, tx);
  if (!isWithinAvailability(schedule, startAt, durationMinutes, timeZone)) {
    throw new AppointmentOutsideAvailabilityError();
  }
}

/**
 * ADR-044 transaction boundary. Before the transaction: booking window
 * (server clock) and timezone (fail closed). Inside one READ COMMITTED
 * transaction: Customer/Professional/Service/association checks, F26
 * availability, the INSERT (the exclusion constraint is the final and
 * only conflict authority — no pre-check SELECT, no retry), and the audit
 * row. After COMMIT only: usage. Any failure rolls back appointment and
 * audit together, and no usage is recorded.
 */
export async function createAppointment(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { customerId: string; professionalId: string; serviceId: string; startAt: Date; notes?: string | null },
  options: ClockOptions = {},
) {
  const now = options.now ?? new Date();
  assertWithinBookingWindow(input.startAt, now);
  const timeZone = await getTimezoneOrThrow(tenant);

  const created = await db.transaction(async (tx) => {
    await requireBookableCustomer(tenant, input.customerId, tx);
    const { service } = await requireBookablePair(tenant, input.professionalId, input.serviceId, tx);
    await requireWithinAvailability(tenant, input.professionalId, input.startAt, service.durationMinutes, timeZone, tx);

    const snapshot = buildBookingSnapshot(service, input.startAt);
    const row = await withConflictMapping(() =>
      insertAppointment(
        tenant,
        { customerId: input.customerId, professionalId: input.professionalId, serviceId: input.serviceId, notes: input.notes ?? null, ...snapshot },
        tx,
      ),
    );

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.created",
        resourceType: "appointment",
        resourceId: row.id,
        metadata: {
          customerId: row.customerId,
          professionalId: row.professionalId,
          serviceId: row.serviceId,
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
        },
        requestId,
      },
      tx,
    );
    return row;
  });

  await recordUsage(tenant.organizationId, `appointment.created:${created.id}`, { resourceType: "appointment", resourceId: created.id }, requestId);
  return toAppointmentDto(created);
}

export async function getAppointmentOrThrow(tenant: TenantContext, id: string) {
  const row = await getAppointment(tenant, id);
  if (!row) throw new AppointmentNotFoundError();
  return toAppointmentDto(row);
}

/** F27A §41: `from`/`to` are inclusive organization-local dates (the F26 query shape), converted server-side to one absolute window — the Console never does timezone math for queries. */
export async function listAppointmentsOrThrow(
  tenant: TenantContext,
  query: { from: string; to: string; professionalId?: string; customerId?: string; serviceId?: string; status?: AppointmentStatus; limit: number },
) {
  const timeZone = await getTimezoneOrThrow(tenant);
  const window = localDateWindow(query.from, query.to, timeZone);
  const rows = await listAppointments(tenant, {
    windowStart: window.start,
    windowEnd: window.end,
    professionalId: query.professionalId,
    customerId: query.customerId,
    serviceId: query.serviceId,
    status: query.status,
    limit: query.limit,
  });
  return rows.map(toAppointmentDto);
}

/**
 * PATCH (ADR-043): `startAt` and/or `professionalId` = a RESCHEDULE (same
 * row, same Customer/Service/snapshots, duration preserved from the
 * appointment itself — never re-read from the Service); `notes` alone = an
 * edit. Only from SCHEDULED. `status`, `customerId`, `serviceId`, `endAt`
 * are not accepted by the schema at all — lifecycle changes go through
 * the dedicated cancel/complete endpoints. The row lock serializes
 * concurrent mutations of THIS appointment; the exclusion constraint
 * guards the new interval against every OTHER appointment.
 */
export async function updateAppointmentOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  id: string,
  patch: { startAt?: Date; professionalId?: string; notes?: string | null },
  options: ClockOptions = {},
) {
  const now = options.now ?? new Date();
  const wantsTimeChange = patch.startAt !== undefined || patch.professionalId !== undefined;
  // Read BEFORE opening the transaction: it uses its own pooled
  // connection, and taking a second connection while holding the
  // transaction's one could exhaust the pool under concurrency.
  const timeZone = wantsTimeChange ? await getTimezoneOrThrow(tenant) : undefined;

  const outcome = await db.transaction(async (tx) => {
    const current = await getAppointmentForUpdate(tenant, id, tx);
    if (!current) throw new AppointmentNotFoundError();

    const newStartAt = patch.startAt ?? current.startAt;
    const newProfessionalId = patch.professionalId ?? current.professionalId;
    const timeChanged = newStartAt.getTime() !== current.startAt.getTime() || newProfessionalId !== current.professionalId;
    const notesChanged = patch.notes !== undefined && patch.notes !== current.notes;

    assertTransition(current.status, timeChanged ? "reschedule" : "update");
    if (!timeChanged && !notesChanged) return { row: current, rescheduled: false };

    if (!timeChanged) {
      const row = await updateAppointment(tenant, id, { notes: patch.notes ?? null }, tx);
      await recordAuditEvent(
        {
          organizationId: tenant.organizationId,
          actorType: actor.type,
          actorId: actor.id,
          action: "appointment.updated",
          resourceType: "appointment",
          resourceId: id,
          // Never the note text itself (possible PII) — only what changed.
          metadata: { changedFields: ["notes"] },
          requestId,
        },
        tx,
      );
      return { row, rescheduled: false };
    }

    assertWithinBookingWindow(newStartAt, now);
    await requireBookableCustomer(tenant, current.customerId, tx);
    await requireBookablePair(tenant, newProfessionalId, current.serviceId, tx);
    const durationMinutes = minutesBetween(current.startAt, current.endAt);
    await requireWithinAvailability(tenant, newProfessionalId, newStartAt, durationMinutes, timeZone!, tx);

    const newEndAt = new Date(newStartAt.getTime() + (current.endAt.getTime() - current.startAt.getTime()));
    const row = await withConflictMapping(() =>
      updateAppointment(
        tenant,
        id,
        { startAt: newStartAt, endAt: newEndAt, professionalId: newProfessionalId, ...(notesChanged ? { notes: patch.notes ?? null } : {}) },
        tx,
      ),
    );

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.rescheduled",
        resourceType: "appointment",
        resourceId: id,
        metadata: {
          from: { startAt: current.startAt.toISOString(), endAt: current.endAt.toISOString(), professionalId: current.professionalId },
          to: { startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(), professionalId: row.professionalId },
          notesChanged,
        },
        requestId,
      },
      tx,
    );
    return { row, rescheduled: true };
  });

  if (outcome.rescheduled) {
    await recordUsage(
      tenant.organizationId,
      `appointment.rescheduled:${id}:${requestId ?? outcome.row.updatedAt.getTime()}`,
      { resourceType: "appointment", resourceId: id },
      requestId,
    );
  }
  return toAppointmentDto(outcome.row);
}

/** SCHEDULED -> CANCELED (ADR-043): any time, releases the interval immediately (the row leaves the constraint's predicate), irreversible. Allowed even if Customer/Professional/Service were archived since booking. */
export async function cancelAppointment(tenant: TenantContext, actor: Actor, requestId: string | undefined, id: string, input: { reason?: string }) {
  const row = await db.transaction(async (tx) => {
    const current = await getAppointmentForUpdate(tenant, id, tx);
    if (!current) throw new AppointmentNotFoundError();
    assertTransition(current.status, "cancel");
    const updated = await updateAppointment(tenant, id, { status: "CANCELED", canceledAt: new Date(), cancellationReason: input.reason ?? null }, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.canceled",
        resourceType: "appointment",
        resourceId: id,
        metadata: { fromStatus: current.status, hasReason: input.reason !== undefined },
        requestId,
      },
      tx,
    );
    return updated;
  });

  await recordUsage(tenant.organizationId, `appointment.canceled:${id}`, { resourceType: "appointment", resourceId: id }, requestId);
  return toAppointmentDto(row);
}

/** SCHEDULED -> COMPLETED (ADR-043): only once the SERVER clock reaches `start_at`. Keeps occupying its interval. No billing/stock side effect. */
export async function completeAppointment(tenant: TenantContext, actor: Actor, requestId: string | undefined, id: string, options: ClockOptions = {}) {
  const row = await db.transaction(async (tx) => {
    const current = await getAppointmentForUpdate(tenant, id, tx);
    if (!current) throw new AppointmentNotFoundError();
    const now = options.now ?? new Date();
    assertTransition(current.status, "complete", { now, startAt: current.startAt });
    const updated = await updateAppointment(tenant, id, { status: "COMPLETED", completedAt: now }, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "appointment.completed",
        resourceType: "appointment",
        resourceId: id,
        requestId,
      },
      tx,
    );
    return updated;
  });

  await recordUsage(tenant.organizationId, `appointment.completed:${id}`, { resourceType: "appointment", resourceId: id }, requestId);
  return toAppointmentDto(row);
}

/**
 * ADR-040 "bookable = working − appointment conflicts", for ONE local
 * date and ONE Service. Same preconditions/errors as F26 availability
 * (timezone 409, archived 409, missing/not-associated 404). ADVISORY: a
 * returned slot can still lose a race — only the write is authoritative.
 * No audit, no usage (a read).
 */
export async function getBookableSlotsOrThrow(tenant: TenantContext, professionalId: string, query: { date: string; serviceId: string }, options: ClockOptions = {}) {
  const now = options.now ?? new Date();
  const timeZone = await getTimezoneOrThrow(tenant);
  const { service } = await requireBookablePair(tenant, professionalId, query.serviceId, db);
  const window = localDateWindow(query.date, query.date, timeZone);
  const [schedule, occupied] = await Promise.all([
    loadSchedule(tenant, professionalId, query.date, db),
    listOccupyingForProfessional(tenant, professionalId, window.start, window.end),
  ]);
  const slots = computeBookableSlots({
    schedule,
    date: query.date,
    durationMinutes: service.durationMinutes,
    timeZone,
    occupied,
    now,
    horizonEnd: new Date(now.getTime() + BOOKING_HORIZON_DAYS * 86_400_000),
  });
  return { timezone: timeZone, date: query.date, serviceId: service.id, durationMinutes: service.durationMinutes, slots };
}
