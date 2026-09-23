import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getAssociation, getProfessional } from "../professionals/repository.js";
import { getService } from "../services/repository.js";
import { getTimezoneOrThrow } from "../organizationSettings/service.js";
import { ConflictError, NotFoundError, ProfessionalArchivedError, ServiceArchivedError, ValidationError, isUniqueViolationError } from "../../shared/errors.js";
import { computeAvailability, findOverlappingPair, type Interval } from "./availability.js";
import {
  deleteScheduleException,
  hasClosedMarkerForDate,
  hasIntervalRowsForDate,
  insertScheduleException,
  listScheduleExceptions,
  listScheduleExceptionsInRange,
  listScheduleRules,
  replaceScheduleRules,
  type ScheduleRuleInput,
  type TenantContext,
} from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

async function getProfessionalOrThrow(tenant: TenantContext, professionalId: string) {
  const professional = await getProfessional(tenant, professionalId);
  if (!professional) throw new NotFoundError("Professional not found");
  return professional;
}

export async function getScheduleOrThrow(tenant: TenantContext, professionalId: string) {
  await getProfessionalOrThrow(tenant, professionalId);
  return listScheduleRules(tenant, professionalId);
}

/**
 * ADR-039 D10: atomic whole-set replacement — delete-all + insert-all in
 * one transaction, so a rejected write leaves the previous schedule
 * completely unchanged (never a partial write). Overlap validation
 * compares the SUBMITTED rows against each other, grouped by
 * `dayOfWeek` (Zod already validated each row's own shape/`start<end`).
 *
 * Editing an archived Professional's schedule is ALLOWED — mirrors
 * `updateProfessionalOrThrow`'s own posture (archived status blocks
 * NEW `professional_services` associations, not ordinary field edits);
 * only AVAILABILITY READS are blocked for an archived Professional
 * (`getAvailabilityOrThrow` below), since that's the "is this bookable
 * right now" question, not a configuration question (docs/f26-report.md
 * §12).
 */
export async function replaceScheduleOrThrow(tenant: TenantContext, actor: Actor, requestId: string | undefined, professionalId: string, rules: ScheduleRuleInput[]) {
  await getProfessionalOrThrow(tenant, professionalId);

  const byDay = new Map<number, Interval[]>();
  for (const rule of rules) {
    const list = byDay.get(rule.dayOfWeek) ?? [];
    list.push({ start: rule.startLocalTime, end: rule.endLocalTime });
    byDay.set(rule.dayOfWeek, list);
  }
  for (const [dayOfWeek, intervals] of byDay) {
    const overlap = findOverlappingPair(intervals);
    if (overlap) {
      throw new ValidationError(`Overlapping intervals on dayOfWeek ${dayOfWeek}: ${overlap[0].start}-${overlap[0].end} overlaps ${overlap[1].start}-${overlap[1].end}`);
    }
  }

  const saved = await db.transaction(async (tx) => {
    const rows = await replaceScheduleRules(tenant, professionalId, rules, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "schedule.updated",
        resourceType: "professional_schedule",
        resourceId: professionalId,
        metadata: { ruleCount: rules.length },
        requestId,
      },
      tx,
    );
    return rows;
  });

  await recordUsage(tenant.organizationId, `schedule.updated:${professionalId}:${requestId ?? Date.now()}`, { resourceType: "professional_schedule", resourceId: professionalId }, requestId);
  return saved;
}

export async function listExceptionsOrThrow(tenant: TenantContext, professionalId: string) {
  await getProfessionalOrThrow(tenant, professionalId);
  return listScheduleExceptions(tenant, professionalId);
}

/**
 * ADR-039 D4/D24: an interval row (`startLocalTime`/`endLocalTime` both
 * set) or a closed-marker row (both absent) — Zod already rejects any
 * other shape. Duplicate closed-marker for the same date -> `409`,
 * enforced by the database's own partial unique index
 * (`isUniqueViolationError`, same mechanism `professional_services`
 * uses for its own duplicate case). The mixed-shape contradiction
 * (closed-marker + interval rows coexisting for one date) is rejected
 * here, at the service layer, inside the same transaction as the
 * existence checks — an application-level check, not a DB constraint,
 * since exception writes are low-frequency staff configuration, not a
 * high-contention resource (docs/f26-report.md §9).
 */
export async function createExceptionOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  professionalId: string,
  input: { date: string; startLocalTime?: string; endLocalTime?: string },
) {
  const isClosedMarker = input.startLocalTime === undefined;

  const created = await db.transaction(async (tx) => {
    await getProfessionalOrThrow(tenant, professionalId);

    if (isClosedMarker) {
      if (await hasIntervalRowsForDate(tenant, professionalId, input.date, tx)) {
        throw new ConflictError(`Date ${input.date} already has available intervals configured; remove them before marking it fully unavailable`);
      }
    } else {
      if (await hasClosedMarkerForDate(tenant, professionalId, input.date, tx)) {
        throw new ConflictError(`Date ${input.date} is already marked fully unavailable; remove that exception before adding intervals`);
      }
      const existingIntervals = await listScheduleExceptionsInRange(tenant, professionalId, input.date, input.date, tx);
      const candidate: Interval = { start: input.startLocalTime!, end: input.endLocalTime! };
      const overlap = findOverlappingPair([
        ...existingIntervals.filter((row) => row.startLocalTime !== null).map((row) => ({ start: row.startLocalTime!, end: row.endLocalTime! })),
        candidate,
      ]);
      if (overlap) {
        throw new ValidationError(`Overlapping exception intervals on ${input.date}: ${overlap[0].start}-${overlap[0].end} overlaps ${overlap[1].start}-${overlap[1].end}`);
      }
    }

    let row;
    try {
      row = await insertScheduleException(tenant, professionalId, input, tx);
    } catch (error) {
      if (isUniqueViolationError(error)) {
        throw new ConflictError(`Date ${input.date} is already marked fully unavailable`);
      }
      throw error;
    }

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "schedule.exception.created",
        resourceType: "professional_schedule_exception",
        resourceId: row.id,
        metadata: { date: input.date, closedMarker: isClosedMarker },
        requestId,
      },
      tx,
    );
    return row;
  });

  await recordUsage(
    tenant.organizationId,
    `schedule.exception.created:${created.id}`,
    { resourceType: "professional_schedule_exception", resourceId: created.id },
    requestId,
  );
  return created;
}

/** Removal is always allowed regardless of Professional archived status — narrowing what exists is never a new capability, mirroring `removeAssociation`'s own posture (ADR-037). Physical delete; `404` if no such exception exists — never a silent no-op. */
export async function removeExceptionOrThrow(tenant: TenantContext, actor: Actor, requestId: string | undefined, professionalId: string, exceptionId: string) {
  await db.transaction(async (tx) => {
    await getProfessionalOrThrow(tenant, professionalId);
    const deleted = await deleteScheduleException(tenant, professionalId, exceptionId, tx);
    if (!deleted) throw new NotFoundError("Schedule exception not found");

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "schedule.exception.removed",
        resourceType: "professional_schedule_exception",
        resourceId: deleted.id,
        metadata: { date: deleted.date },
        requestId,
      },
      tx,
    );
  });
}

/**
 * ADR-039/040/041 — the F26 availability engine's entry point. Fails
 * closed (never silently defaults) on: missing Organization timezone,
 * a nonexistent Professional, or an ARCHIVED Professional (an archived
 * Professional's computed availability reads as blocked, not silently
 * empty — the more informative of ADR-039's two documented options,
 * consistent with this codebase's established "fail loud with a clear
 * error, never fail silently empty" posture). With `serviceId`: the
 * Service must exist in this tenant, be `ACTIVE`, and be associated
 * with this Professional via `professional_services` — read live, NEVER
 * duplicated into Scheduling's own tables (ADR-039 D12). No audit, no
 * usage — a read-only computation (F26 brief §21: "do not create noisy
 * audit records for read-only availability calculations").
 */
export async function getAvailabilityOrThrow(tenant: TenantContext, professionalId: string, query: { from: string; to: string; serviceId?: string }) {
  const timezone = await getTimezoneOrThrow(tenant);

  const professional = await getProfessionalOrThrow(tenant, professionalId);
  if (professional.status === "ARCHIVED") {
    throw new ProfessionalArchivedError(`Professional "${professional.name}" is archived; availability cannot be computed`);
  }

  let durationMinutes: number | undefined;
  if (query.serviceId) {
    const service = await getService(tenant, query.serviceId);
    if (!service) throw new NotFoundError("Service not found");
    if (service.status === "ARCHIVED") {
      throw new ServiceArchivedError(`Service "${service.name}" is archived; availability cannot be computed for it`);
    }
    const association = await getAssociation(tenant, professionalId, query.serviceId);
    if (!association) throw new NotFoundError(`Professional "${professional.name}" is not associated with service "${service.name}"`);
    durationMinutes = service.durationMinutes;
  }

  const [rules, exceptions] = await Promise.all([
    listScheduleRules(tenant, professionalId),
    listScheduleExceptionsInRange(tenant, professionalId, query.from, query.to),
  ]);

  const days = computeAvailability({
    rules: rules.map((row) => ({ dayOfWeek: row.dayOfWeek, startLocalTime: row.startLocalTime, endLocalTime: row.endLocalTime })),
    exceptions: exceptions.map((row) => ({ date: row.date, startLocalTime: row.startLocalTime, endLocalTime: row.endLocalTime })),
    from: query.from,
    to: query.to,
    durationMinutes,
  });

  return { timezone, days };
}
