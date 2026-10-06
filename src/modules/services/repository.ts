import { and, count, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { services } from "../../db/schema/index.js";
import { likeSubstring, orderByAllowlisted } from "../../shared/listing.js";

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
  offset?: number;
  sort?: ServiceSort;
  order?: "asc" | "desc";
}

/** ADR-052: public sort name -> column. The only columns a client can sort by. */
export const SERVICES_SORT_COLUMNS = { createdAt: services.createdAt, name: services.name };
export type ServiceSort = keyof typeof SERVICES_SORT_COLUMNS;

/** One WHERE for both the page and its count — `total` can never use a different tenant filter than the rows. */
function servicesConditions(tenant: TenantContext, filters: Omit<ServiceFilters, "limit">): SQL | undefined {
  const conditions = [eq(services.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(services.status, filters.status));
  if (filters.q) conditions.push(ilike(services.name, likeSubstring(filters.q)));
  return and(...conditions);
}

export async function listServices(tenant: TenantContext, filters: ServiceFilters, executor: Executor = db) {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(services)
    .where(servicesConditions(tenant, filters))
    .orderBy(...orderByAllowlisted(SERVICES_SORT_COLUMNS, services.id, filters.sort ?? "createdAt", filters.order ?? "desc"))
    .limit(filters.limit)
    .offset(filters.offset ?? 0);
  return rows;
}

export async function countServices(tenant: TenantContext, filters: Omit<ServiceFilters, "limit">, executor: Executor = db): Promise<number> {
  assertTenant(tenant);
  const [row] = await executor.select({ total: count() }).from(services).where(servicesConditions(tenant, filters));
  return row?.total ?? 0;
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
