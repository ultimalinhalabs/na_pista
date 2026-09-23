import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { professionalServices, professionals, services } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: the only place with SQL for professionals/professional_services, requires a TenantContext (F25 brief §20). */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update" | "delete">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export async function insertProfessional(
  tenant: TenantContext,
  input: { name: string; description?: string; phone?: string; email?: string },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(professionals)
    .values({
      organizationId: tenant.organizationId,
      name: input.name,
      description: input.description,
      phone: input.phone,
      email: input.email,
    })
    .returning();
  return row!;
}

export interface ProfessionalFilters {
  status?: "ACTIVE" | "ARCHIVED";
  q?: string;
  serviceId?: string;
  limit: number;
}

/** `serviceId` filters to Professionals associated (via professional_services) with that Service — ADR-037/F25A §14. */
export async function listProfessionals(tenant: TenantContext, filters: ProfessionalFilters, executor: Executor = db) {
  assertTenant(tenant);
  const conditions = [eq(professionals.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(professionals.status, filters.status));
  if (filters.q) conditions.push(ilike(professionals.name, `%${filters.q}%`));
  if (filters.serviceId) {
    conditions.push(
      inArray(
        professionals.id,
        db
          .select({ professionalId: professionalServices.professionalId })
          .from(professionalServices)
          .where(and(eq(professionalServices.organizationId, tenant.organizationId), eq(professionalServices.serviceId, filters.serviceId))),
      ),
    );
  }
  return executor
    .select()
    .from(professionals)
    .where(and(...conditions))
    .orderBy(desc(professionals.createdAt))
    .limit(filters.limit);
}

/** Another organization's professional id resolves to `undefined` — the service layer turns that into 404 (tenancy.md §3). Intentionally NOT `getProfessionalById(id)` alone — every read requires a TenantContext (F25 brief §20). */
export async function getProfessional(tenant: TenantContext, id: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(professionals)
    .where(and(eq(professionals.organizationId, tenant.organizationId), eq(professionals.id, id)))
    .limit(1);
  return row;
}

export async function updateProfessional(
  tenant: TenantContext,
  id: string,
  patch: { name?: string; description?: string | null; phone?: string | null; email?: string | null; status?: "ACTIVE" | "ARCHIVED" },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .update(professionals)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(professionals.organizationId, tenant.organizationId), eq(professionals.id, id)))
    .returning();
  return row;
}

/** F26: read-only existence check, reused cross-module by Scheduling's availability engine (ADR-039 D12 — never duplicates this relationship, always reads it live) — the exact same cross-module read pattern `getService` already establishes. */
export async function getAssociation(tenant: TenantContext, professionalId: string, serviceId: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(professionalServices)
    .where(
      and(
        eq(professionalServices.organizationId, tenant.organizationId),
        eq(professionalServices.professionalId, professionalId),
        eq(professionalServices.serviceId, serviceId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * ADR-037: a plain insert — duplicate-prevention is the database's own
 * `UNIQUE(organization_id, professional_id, service_id)` constraint,
 * translated to `409 CONFLICT` by the service layer via
 * `isUniqueViolationError`, never a pre-check-then-insert race.
 */
export async function insertAssociation(tenant: TenantContext, professionalId: string, serviceId: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(professionalServices)
    .values({ organizationId: tenant.organizationId, professionalId, serviceId })
    .returning();
  return row!;
}

/** Physical delete — the only one in this domain (ADR-037: a pure join row has no historical value of its own). Returns the deleted row, or `undefined` if no such association existed. */
export async function deleteAssociation(tenant: TenantContext, professionalId: string, serviceId: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .delete(professionalServices)
    .where(
      and(
        eq(professionalServices.organizationId, tenant.organizationId),
        eq(professionalServices.professionalId, professionalId),
        eq(professionalServices.serviceId, serviceId),
      ),
    )
    .returning();
  return row;
}

/** The Services a Professional is associated with — joined with `services` for display fields (name/duration/price/status), matching Inventory's own `listBalances` join-for-display precedent. */
export async function listServicesForProfessional(tenant: TenantContext, professionalId: string, executor: Executor = db) {
  assertTenant(tenant);
  return executor
    .select({
      id: services.id,
      name: services.name,
      durationMinutes: services.durationMinutes,
      price: services.price,
      status: services.status,
      associatedAt: professionalServices.createdAt,
    })
    .from(professionalServices)
    .innerJoin(services, and(eq(services.organizationId, professionalServices.organizationId), eq(services.id, professionalServices.serviceId)))
    .where(and(eq(professionalServices.organizationId, tenant.organizationId), eq(professionalServices.professionalId, professionalId)))
    .orderBy(desc(professionalServices.createdAt));
}
