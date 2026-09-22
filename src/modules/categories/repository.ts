import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { categories } from "../../db/schema/index.js";

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

export async function listCategories(
  tenant: TenantContext,
  filters: { status?: "ACTIVE" | "ARCHIVED"; limit: number },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const conditions = [eq(categories.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(categories.status, filters.status));
  return executor
    .select()
    .from(categories)
    .where(and(...conditions))
    .orderBy(desc(categories.createdAt))
    .limit(filters.limit);
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
