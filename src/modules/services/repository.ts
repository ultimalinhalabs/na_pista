import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../db/index.js";
import { services } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: the only place with SQL for services, requires a TenantContext (F24 brief §16). */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export async function insertService(
  tenant: TenantContext,
  input: { name: string; description?: string; durationMinutes: number; price?: string },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(services)
    .values({
      organizationId: tenant.organizationId,
      name: input.name,
      description: input.description,
      durationMinutes: input.durationMinutes,
      ...(input.price !== undefined ? { price: input.price } : {}),
    })
    .returning();
  return row!;
}

export interface ServiceFilters {
  status?: "ACTIVE" | "ARCHIVED";
  q?: string;
  limit: number;
}

export async function listServices(tenant: TenantContext, filters: ServiceFilters, executor: Executor = db) {
  assertTenant(tenant);
  const conditions = [eq(services.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(services.status, filters.status));
  if (filters.q) conditions.push(ilike(services.name, `%${filters.q}%`));
  return executor
    .select()
    .from(services)
    .where(and(...conditions))
    .orderBy(desc(services.createdAt))
    .limit(filters.limit);
}

/** Another organization's service id resolves to `undefined` — the service layer turns that into 404 (tenancy.md §3). Intentionally NOT `getServiceById(id)` alone — every read requires a TenantContext (F24 brief §16). */
export async function getService(tenant: TenantContext, id: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(services)
    .where(and(eq(services.organizationId, tenant.organizationId), eq(services.id, id)))
    .limit(1);
  return row;
}

export async function updateService(
  tenant: TenantContext,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    durationMinutes?: number;
    price?: string | null;
    status?: "ACTIVE" | "ARCHIVED";
  },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .update(services)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(services.organizationId, tenant.organizationId), eq(services.id, id)))
    .returning();
  return row;
}
