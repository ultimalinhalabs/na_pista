import { and, asc, eq, gte, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../../db/index.js";
import { professionalScheduleExceptions, professionalScheduleRules } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: the only place with SQL for scheduling rules/exceptions — requires a TenantContext, same guard convention as every other module. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "delete">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export interface ScheduleRuleInput {
  dayOfWeek: number;
  startLocalTime: string;
  endLocalTime: string;
}

/**
 * postgres.js/Drizzle round-trip a `TIME` column as `"HH:mm:ss"` (a real,
 * empirically-confirmed behavior — not an assumption), not the `"HH:mm"`
 * ADR-040 fixes as the API representation. Normalized once, here, at the
 * repository boundary — every caller (routes.ts, the pure availability
 * engine) gets a consistent `"HH:mm"` string without having to remember
 * to strip it themselves.
 */
function normalizeTime<T extends string | null>(value: T): T {
  return (value === null ? null : value.slice(0, 5)) as T;
}

function normalizeRuleRow<T extends { startLocalTime: string; endLocalTime: string }>(row: T): T {
  return { ...row, startLocalTime: normalizeTime(row.startLocalTime), endLocalTime: normalizeTime(row.endLocalTime) };
}

function normalizeExceptionRow<T extends { startLocalTime: string | null; endLocalTime: string | null }>(row: T): T {
  return { ...row, startLocalTime: normalizeTime(row.startLocalTime), endLocalTime: normalizeTime(row.endLocalTime) };
}

export async function listScheduleRules(tenant: TenantContext, professionalId: string, executor: Executor = db) {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(professionalScheduleRules)
    .where(and(eq(professionalScheduleRules.organizationId, tenant.organizationId), eq(professionalScheduleRules.professionalId, professionalId)))
    .orderBy(asc(professionalScheduleRules.dayOfWeek), asc(professionalScheduleRules.startLocalTime));
  return rows.map(normalizeRuleRow);
}

/** Atomic whole-set replacement (ADR-039 D10): delete every existing rule row for this Professional, insert the new set — always called inside the caller's own transaction, never on its own. */
export async function replaceScheduleRules(tenant: TenantContext, professionalId: string, rules: ScheduleRuleInput[], executor: Executor = db) {
  assertTenant(tenant);
  await executor
    .delete(professionalScheduleRules)
    .where(and(eq(professionalScheduleRules.organizationId, tenant.organizationId), eq(professionalScheduleRules.professionalId, professionalId)));
  if (rules.length === 0) return [];
  const rows = await executor
    .insert(professionalScheduleRules)
    .values(rules.map((rule) => ({ organizationId: tenant.organizationId, professionalId, ...rule })))
    .returning();
  return rows.map(normalizeRuleRow);
}

export async function listScheduleExceptions(tenant: TenantContext, professionalId: string, executor: Executor = db) {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(professionalScheduleExceptions)
    .where(and(eq(professionalScheduleExceptions.organizationId, tenant.organizationId), eq(professionalScheduleExceptions.professionalId, professionalId)))
    .orderBy(asc(professionalScheduleExceptions.date), asc(professionalScheduleExceptions.startLocalTime));
  return rows.map(normalizeExceptionRow);
}

/** Exceptions within [from, to] (inclusive), used by the availability engine — never loads a Professional's entire exception history for a bounded query (ADR-039 D34). */
export async function listScheduleExceptionsInRange(tenant: TenantContext, professionalId: string, from: string, to: string, executor: Executor = db) {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(professionalScheduleExceptions)
    .where(
      and(
        eq(professionalScheduleExceptions.organizationId, tenant.organizationId),
        eq(professionalScheduleExceptions.professionalId, professionalId),
        gte(professionalScheduleExceptions.date, from),
        lte(professionalScheduleExceptions.date, to),
      ),
    )
    .orderBy(asc(professionalScheduleExceptions.date), asc(professionalScheduleExceptions.startLocalTime));
  return rows.map(normalizeExceptionRow);
}

/** A plain insert — the closed-marker duplicate case relies on the DB's own partial unique index (`isUniqueViolationError` -> 409, same pattern as `professional_services`); the mixed-shape contradiction (closed-marker + interval rows on one date) is checked at the domain-service layer before this is called. */
export async function insertScheduleException(
  tenant: TenantContext,
  professionalId: string,
  input: { date: string; startLocalTime?: string; endLocalTime?: string },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(professionalScheduleExceptions)
    .values({
      organizationId: tenant.organizationId,
      professionalId,
      date: input.date,
      startLocalTime: input.startLocalTime,
      endLocalTime: input.endLocalTime,
    })
    .returning();
  return normalizeExceptionRow(row!);
}

/** Physical delete by row id — mirrors `professional_services`' own disassociation semantics: returns the deleted row, or `undefined` if no such exception existed (the service layer turns that into a 404, never a silent no-op). */
export async function deleteScheduleException(tenant: TenantContext, professionalId: string, exceptionId: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .delete(professionalScheduleExceptions)
    .where(
      and(
        eq(professionalScheduleExceptions.organizationId, tenant.organizationId),
        eq(professionalScheduleExceptions.professionalId, professionalId),
        eq(professionalScheduleExceptions.id, exceptionId),
      ),
    )
    .returning();
  return row ? normalizeExceptionRow(row) : row;
}

/** Whether a closed-marker (fully-unavailable) row already exists for this date — used to reject a contradictory interval-row insert. */
export async function hasClosedMarkerForDate(tenant: TenantContext, professionalId: string, date: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select({ id: professionalScheduleExceptions.id })
    .from(professionalScheduleExceptions)
    .where(
      and(
        eq(professionalScheduleExceptions.organizationId, tenant.organizationId),
        eq(professionalScheduleExceptions.professionalId, professionalId),
        eq(professionalScheduleExceptions.date, date),
        isNull(professionalScheduleExceptions.startLocalTime),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Whether any interval rows already exist for this date — used to reject a contradictory closed-marker insert. */
export async function hasIntervalRowsForDate(tenant: TenantContext, professionalId: string, date: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select({ id: professionalScheduleExceptions.id })
    .from(professionalScheduleExceptions)
    .where(
      and(
        eq(professionalScheduleExceptions.organizationId, tenant.organizationId),
        eq(professionalScheduleExceptions.professionalId, professionalId),
        eq(professionalScheduleExceptions.date, date),
        isNotNull(professionalScheduleExceptions.startLocalTime),
      ),
    )
    .limit(1);
  return Boolean(row);
}
