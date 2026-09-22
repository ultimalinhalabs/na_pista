import { and, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: the only place with SQL for customers, requires a TenantContext (F21 brief §12). */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export async function insertCustomer(
  tenant: TenantContext,
  input: { name: string; email?: string; phone?: string; notes?: string },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(customers)
    .values({ organizationId: tenant.organizationId, name: input.name, email: input.email, phone: input.phone, notes: input.notes })
    .returning();
  return row!;
}

export interface CustomerFilters {
  status?: "ACTIVE" | "ARCHIVED";
  q?: string;
  limit: number;
}

/** `q` searches name/email/phone — plain ILIKE, tenant-scoped, no full-text engine (F21 brief §6). */
export async function listCustomers(tenant: TenantContext, filters: CustomerFilters, executor: Executor = db) {
  assertTenant(tenant);
  const conditions = [eq(customers.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(customers.status, filters.status));
  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(or(ilike(customers.name, term), ilike(customers.email, term), ilike(customers.phone, term))!);
  }
  return executor
    .select()
    .from(customers)
    .where(and(...conditions))
    .orderBy(desc(customers.createdAt))
    .limit(filters.limit);
}

/** Another organization's customer id resolves to `undefined` — the route layer turns that into 404. */
export async function getCustomer(tenant: TenantContext, id: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(customers)
    .where(and(eq(customers.organizationId, tenant.organizationId), eq(customers.id, id)))
    .limit(1);
  return row;
}

export async function updateCustomer(
  tenant: TenantContext,
  id: string,
  patch: { name?: string; email?: string | null; phone?: string | null; notes?: string | null; status?: "ACTIVE" | "ARCHIVED" },
  executor: Executor = db,
) {
  assertTenant(tenant);
  const [row] = await executor
    .update(customers)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(customers.organizationId, tenant.organizationId), eq(customers.id, id)))
    .returning();
  return row;
}
