import { and, count, eq, ilike, or, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/index.js";
import { likeSubstring, orderByAllowlisted } from "../../shared/listing.js";

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

/** `q` searches name/email/phone — plain ILIKE, tenant-scoped, no full-text engine (F21 brief §6). */
export interface CustomerFilters {
  status?: "ACTIVE" | "ARCHIVED";
  q?: string;
  limit: number;
  offset?: number;
  sort?: CustomerSort;
  order?: "asc" | "desc";
}

/** ADR-052: public sort name -> column. The only columns a client can sort by. */
export const CUSTOMERS_SORT_COLUMNS = { createdAt: customers.createdAt, name: customers.name };
export type CustomerSort = keyof typeof CUSTOMERS_SORT_COLUMNS;

/** One WHERE for both the page and its count — `total` can never use a different tenant filter than the rows. */
function customersConditions(tenant: TenantContext, filters: Omit<CustomerFilters, "limit">): SQL | undefined {
  const conditions = [eq(customers.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(customers.status, filters.status));
  if (filters.q) {
    const term = likeSubstring(filters.q);
    conditions.push(or(ilike(customers.name, term), ilike(customers.email, term), ilike(customers.phone, term))!);
  }
  return and(...conditions);
}

export async function listCustomers(tenant: TenantContext, filters: CustomerFilters, executor: Executor = db) {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(customers)
    .where(customersConditions(tenant, filters))
    .orderBy(...orderByAllowlisted(CUSTOMERS_SORT_COLUMNS, customers.id, filters.sort ?? "createdAt", filters.order ?? "desc"))
    .limit(filters.limit)
    .offset(filters.offset ?? 0);
  return rows;
}

export async function countCustomers(tenant: TenantContext, filters: Omit<CustomerFilters, "limit">, executor: Executor = db): Promise<number> {
  assertTenant(tenant);
  const [row] = await executor.select({ total: count() }).from(customers).where(customersConditions(tenant, filters));
  return row?.total ?? 0;
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
