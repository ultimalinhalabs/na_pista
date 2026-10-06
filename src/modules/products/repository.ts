import { and, count, eq, ilike, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { products } from "../../db/schema/index.js";
import { likeSubstring, orderByAllowlisted } from "../../shared/listing.js";

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
  input: { name: string; description?: string; categoryId?: string | null; unit?: "UNIT" | "KG" | "G" | "L" | "ML"; price?: string },
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
      ...(input.price !== undefined ? { price: input.price } : {}),
    })
    .returning();
  return row!;
}

export interface ProductFilters {
  status?: "ACTIVE" | "ARCHIVED";
  categoryId?: string;
  q?: string;
  limit: number;
  offset?: number;
  sort?: ProductSort;
  order?: "asc" | "desc";
}

/** ADR-052: public sort name -> column. The only columns a client can sort by. */
export const PRODUCT_SORT_COLUMNS = { createdAt: products.createdAt, name: products.name };
export type ProductSort = keyof typeof PRODUCT_SORT_COLUMNS;

/** One WHERE for both the page and its count — `total` can never use a different tenant filter than the rows. */
function productConditions(tenant: TenantContext, filters: Omit<ProductFilters, "limit">): SQL | undefined {
  const conditions = [eq(products.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(products.status, filters.status));
  if (filters.categoryId) conditions.push(eq(products.categoryId, filters.categoryId));
  if (filters.q) conditions.push(ilike(products.name, likeSubstring(filters.q)));
  return and(...conditions);
}

export async function listProducts(tenant: TenantContext, filters: ProductFilters, executor: Executor = db) {
  assertTenant(tenant);
  return executor
    .select()
    .from(products)
    .where(productConditions(tenant, filters))
    .orderBy(...orderByAllowlisted(PRODUCT_SORT_COLUMNS, products.id, filters.sort ?? "createdAt", filters.order ?? "desc"))
    .limit(filters.limit)
    .offset(filters.offset ?? 0);
}

export async function countProducts(tenant: TenantContext, filters: Omit<ProductFilters, "limit">, executor: Executor = db): Promise<number> {
  assertTenant(tenant);
  const [row] = await executor.select({ total: count() }).from(products).where(productConditions(tenant, filters));
  return row?.total ?? 0;
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
  patch: {
    name?: string;
    description?: string | null;
    categoryId?: string | null;
    status?: "ACTIVE" | "ARCHIVED";
    unit?: "UNIT" | "KG" | "G" | "L" | "ML";
    price?: string | null;
  },
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
