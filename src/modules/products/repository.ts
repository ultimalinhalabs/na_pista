import { and, desc, eq, ilike } from "drizzle-orm";
import { db } from "../../db/index.js";
import { products } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: the only place with SQL for products, requires a TenantContext. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export async function insertProduct(
  tenant: TenantContext,
  input: { name: string; description?: string; categoryId?: string | null; unit?: "UNIT" | "KG" | "G" | "L" | "ML" },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(products)
    .values({
      organizationId: tenant.organizationId,
      name: input.name,
      description: input.description,
      categoryId: input.categoryId ?? null,
      ...(input.unit ? { unit: input.unit } : {}),
    })
    .returning();
  return row!;
}

export interface ProductFilters {
  status?: "ACTIVE" | "ARCHIVED";
  categoryId?: string;
  q?: string;
  limit: number;
}

export async function listProducts(tenant: TenantContext, filters: ProductFilters, executor: Executor = db) {
  assertTenant(tenant);
  const conditions = [eq(products.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(products.status, filters.status));
  if (filters.categoryId) conditions.push(eq(products.categoryId, filters.categoryId));
  if (filters.q) conditions.push(ilike(products.name, `%${filters.q}%`));
  return executor
    .select()
    .from(products)
    .where(and(...conditions))
    .orderBy(desc(products.createdAt))
    .limit(filters.limit);
}

/** Another organization's product id resolves to `undefined` — the route layer turns that into 404 (tenancy.md §3). */
export async function getProduct(tenant: TenantContext, id: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(products)
    .where(and(eq(products.organizationId, tenant.organizationId), eq(products.id, id)))
    .limit(1);
  return row;
}

export async function updateProduct(
  tenant: TenantContext,
  id: string,
  patch: { name?: string; description?: string | null; categoryId?: string | null; status?: "ACTIVE" | "ARCHIVED"; unit?: "UNIT" | "KG" | "G" | "L" | "ML" },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .update(products)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(products.organizationId, tenant.organizationId), eq(products.id, id)))
    .returning();
  return row;
}
