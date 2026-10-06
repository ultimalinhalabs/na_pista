import { and, count, eq, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { categories } from "../../db/schema/index.js";
import { orderByAllowlisted } from "../../shared/listing.js";

/**
 * tenancy.md §3 layer 3, executed: the only place with SQL for
 * categories, and it REQUIRES a TenantContext. Every query has
 * `organization_id` in its WHERE clause by construction — never
 * "SELECT ... WHERE id = $1" (F20 brief §13).
 */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export async function insertCategory(
  tenant: TenantContext,
  input: { name: string; description?: string },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(categories)
    .values({ organizationId: tenant.organizationId, name: input.name, description: input.description })
    .returning();
  return row!;
}

export interface CategoryFilters {
  status?: "ACTIVE" | "ARCHIVED";
  limit: number;
  offset?: number;
  sort?: CategorySort;
  order?: "asc" | "desc";
}

/** ADR-052: public sort name -> column. The only columns a client can sort by. */
export const CATEGORIES_SORT_COLUMNS = { createdAt: categories.createdAt, name: categories.name };
export type CategorySort = keyof typeof CATEGORIES_SORT_COLUMNS;

/** One WHERE for both the page and its count — `total` can never use a different tenant filter than the rows. */
function categoriesConditions(tenant: TenantContext, filters: Omit<CategoryFilters, "limit">): SQL | undefined {
  const conditions = [eq(categories.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(categories.status, filters.status));
  return and(...conditions);
}

export async function listCategories(tenant: TenantContext, filters: CategoryFilters, executor: Executor = db) {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(categories)
    .where(categoriesConditions(tenant, filters))
    .orderBy(...orderByAllowlisted(CATEGORIES_SORT_COLUMNS, categories.id, filters.sort ?? "createdAt", filters.order ?? "desc"))
    .limit(filters.limit)
    .offset(filters.offset ?? 0);
  return rows;
}

export async function countCategories(tenant: TenantContext, filters: Omit<CategoryFilters, "limit">, executor: Executor = db): Promise<number> {
  assertTenant(tenant);
  const [row] = await executor.select({ total: count() }).from(categories).where(categoriesConditions(tenant, filters));
  return row?.total ?? 0;
}

/** Another organization's category id resolves to `undefined` — the route layer turns that into 404. */
export async function getCategory(tenant: TenantContext, id: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(categories)
    .where(and(eq(categories.organizationId, tenant.organizationId), eq(categories.id, id)))
    .limit(1);
  return row;
}

export async function updateCategory(
  tenant: TenantContext,
  id: string,
  patch: { name?: string; description?: string | null; status?: "ACTIVE" | "ARCHIVED" },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .update(categories)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(categories.organizationId, tenant.organizationId), eq(categories.id, id)))
    .returning();
  return row;
}
