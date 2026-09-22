import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { products } from "../../db/schema.js";

/**
 * tenancy.md §3 layer 3, executed: the only place with SQL, and it
 * REQUIRES a TenantContext — there is no function here that can run
 * without one. Every query has `organization_id` in its WHERE clause by
 * construction, never "checked after the fact".
 */
export interface TenantContext {
  organizationId: string;
}

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    // F19 §19 "Repository receives missing tenant context" — this is the
    // defined behavior: a hard failure, never a query that silently
    // spans every organization.
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export async function insertProduct(tenant: TenantContext, input: { name: string }) {
  assertTenant(tenant);
  const [row] = await db
    .insert(products)
    .values({ organizationId: tenant.organizationId, name: input.name })
    .returning();
  return row!;
}

export async function listProducts(tenant: TenantContext) {
  assertTenant(tenant);
  return db.select().from(products).where(eq(products.organizationId, tenant.organizationId));
}

/** Another organization's product id resolves to `undefined` here — the route layer turns that into 404, never 403 (tenancy.md §3). */
export async function getProduct(tenant: TenantContext, id: string) {
  assertTenant(tenant);
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.organizationId, tenant.organizationId), eq(products.id, id)))
    .limit(1);
  return row;
}

export async function countActiveProducts(tenant: TenantContext): Promise<number> {
  assertTenant(tenant);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(products)
    .where(and(eq(products.organizationId, tenant.organizationId), eq(products.status, "ACTIVE")));
  return row?.count ?? 0;
}
