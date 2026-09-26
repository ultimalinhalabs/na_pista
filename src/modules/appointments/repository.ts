import { and, asc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appointments } from "../../db/schema/index.js";
import type { AppointmentStatus } from "./lifecycle.js";

/** tenancy.md §3 layer 3: the only place with SQL for appointments — requires a TenantContext, same guard convention as every other module. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update" | "delete">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export type AppointmentRow = typeof appointments.$inferSelect;

export interface NewAppointment {
  customerId: string;
  professionalId: string;
  serviceId: string;
  startAt: Date;
  endAt: Date;
  serviceName: string;
  servicePrice: string | null;
  currency: string;
  notes: string | null;
}

/** A conflicting insert raises `23P01` from `appointments_professional_no_overlap` — translated by the domain service, never here. */
export async function insertAppointment(tenant: TenantContext, input: NewAppointment, executor: Executor = db): Promise<AppointmentRow> {
  assertTenant(tenant);
  const [row] = await executor
    .insert(appointments)
    .values({ organizationId: tenant.organizationId, ...input })
    .returning();
  return row!;
}

/** Another organization's appointment id resolves to `undefined` — the service layer turns that into 404 (tenancy.md §3). */
export async function getAppointment(tenant: TenantContext, id: string, executor: Executor = db): Promise<AppointmentRow | undefined> {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(appointments)
    .where(and(eq(appointments.organizationId, tenant.organizationId), eq(appointments.id, id)))
    .limit(1);
  return row;
}

/**
 * Row-locking read (`SELECT ... FOR UPDATE`, the `getOrderForUpdate`
 * precedent) — used by every mutation of an EXISTING appointment
 * (reschedule, notes, cancel, complete). A second concurrent mutation of
 * the SAME appointment blocks here until the first commits/rolls back,
 * then observes the real current state (ADR-043). Overlap ACROSS
 * appointments is the exclusion constraint's job, not this lock's.
 * Must only ever be called inside a `db.transaction`.
 */
export async function getAppointmentForUpdate(tenant: TenantContext, id: string, tx: Executor): Promise<AppointmentRow | undefined> {
  assertTenant(tenant);
  const [row] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.organizationId, tenant.organizationId), eq(appointments.id, id)))
    .for("update")
    .limit(1);
  return row;
}

export interface AppointmentFilters {
  /** Absolute window; an appointment is included when it OVERLAPS `[windowStart, windowEnd)`. */
  windowStart: Date;
  windowEnd: Date;
  professionalId?: string;
  customerId?: string;
  serviceId?: string;
  status?: AppointmentStatus;
  limit: number;
}

/** Always bounded: the window is mandatory (callers cap it at 31 local days) and `limit` is capped by the schema. Deterministic order `start_at, id`. */
export async function listAppointments(tenant: TenantContext, filters: AppointmentFilters, executor: Executor = db): Promise<AppointmentRow[]> {
  assertTenant(tenant);
  const conditions = [
    eq(appointments.organizationId, tenant.organizationId),
    lt(appointments.startAt, filters.windowEnd),
    gt(appointments.endAt, filters.windowStart),
  ];
  if (filters.professionalId) conditions.push(eq(appointments.professionalId, filters.professionalId));
  if (filters.customerId) conditions.push(eq(appointments.customerId, filters.customerId));
  if (filters.serviceId) conditions.push(eq(appointments.serviceId, filters.serviceId));
  if (filters.status) conditions.push(eq(appointments.status, filters.status));
  return executor
    .select()
    .from(appointments)
    .where(and(...conditions))
    .orderBy(asc(appointments.startAt), asc(appointments.id))
    .limit(filters.limit);
}

/**
 * Occupying (non-canceled) appointments of one Professional overlapping a
 * window — phrased with the constraint's own expression and predicate so
 * Postgres serves it from the exclusion constraint's GiST index. Used ONLY
 * for the advisory bookable-slots read, never as a write-time guard.
 */
export async function listOccupyingForProfessional(tenant: TenantContext, professionalId: string, windowStart: Date, windowEnd: Date, executor: Executor = db) {
  assertTenant(tenant);
  return executor
    .select({ id: appointments.id, startAt: appointments.startAt, endAt: appointments.endAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.organizationId, tenant.organizationId),
        eq(appointments.professionalId, professionalId),
        ne(appointments.status, "CANCELED"),
        sql`tstzrange(${appointments.startAt}, ${appointments.endAt}, '[)') && tstzrange(${windowStart.toISOString()}::timestamptz, ${windowEnd.toISOString()}::timestamptz, '[)')`,
      ),
    );
}

export type AppointmentPatch = Partial<
  Pick<AppointmentRow, "professionalId" | "startAt" | "endAt" | "notes" | "status" | "cancellationReason" | "canceledAt" | "completedAt" | "noShowAt">
>;

/** A time/professional change can raise `23P01` exactly like an insert — the constraint is checked on every new row version. */
export async function updateAppointment(tenant: TenantContext, id: string, patch: AppointmentPatch, executor: Executor = db): Promise<AppointmentRow> {
  assertTenant(tenant);
  const [row] = await executor
    .update(appointments)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(appointments.organizationId, tenant.organizationId), eq(appointments.id, id)))
    .returning();
  return row!;
}
