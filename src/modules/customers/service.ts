import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { NotFoundError } from "../../shared/errors.js";
import {
  countCustomers,
  getCustomer,
  insertCustomer,
  listCustomers,
  updateCustomer,
  type CustomerFilters,
  type TenantContext,
} from "./repository.js";
import { CUSTOMERS_DEFAULT_PAGE_SIZE, type ListCustomersQuery } from "./schemas.js";
import { pageRequest, type Page } from "../../shared/listing.js";

type CustomerItem = Awaited<ReturnType<typeof listCustomers>>[number];

export interface Actor {
  type: "user" | "service";
  id: string;
}

export async function createCustomer(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { name: string; email?: string; phone?: string; notes?: string },
) {
  const customer = await db.transaction(async (tx) => {
    const row = await insertCustomer(tenant, input, tx);
    // ADR-023/ADR-026: audited in the SAME transaction — an audit
    // failure rolls back the customer row too (never a resource that
    // exists without its creation being audited). No PII beyond the
    // resource id goes into metadata (F21 brief §18) — name/email/phone/
    // notes are never logged.
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "customer.created",
        resourceType: "customer",
        resourceId: row.id,
        requestId,
      },
      tx,
    );
    return row;
  });

  await recordUsage(tenant.organizationId, `customer.created:${customer.id}`, { resourceType: "customer", resourceId: customer.id }, requestId);
  return customer;
}

export async function listAllCustomers(tenant: TenantContext, filters: CustomerFilters) {
  return listCustomers(tenant, filters);
}

/** ADR-051: one page + the tenant-scoped total for the same filters. */
export async function listCustomersPage(tenant: TenantContext, query: ListCustomersQuery): Promise<Page<CustomerItem>> {
  const { page, pageSize, offset } = pageRequest(query, CUSTOMERS_DEFAULT_PAGE_SIZE);
  const { page: _p, pageSize: _s, limit: _l, ...filters } = query;
  const [items, total] = await Promise.all([
    listCustomers(tenant, { ...filters, limit: pageSize, offset }),
    countCustomers(tenant, filters),
  ]);
  return { items, page, pageSize, total };
}

export async function getCustomerOrThrow(tenant: TenantContext, id: string) {
  const customer = await getCustomer(tenant, id);
  if (!customer) throw new NotFoundError("Customer not found");
  return customer;
}

export async function updateCustomerOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  id: string,
  patch: { name?: string; email?: string | null; phone?: string | null; notes?: string | null; status?: "ACTIVE" | "ARCHIVED" },
) {
  const customer = await db.transaction(async (tx) => {
    const existing = await getCustomer(tenant, id, tx);
    if (!existing) throw new NotFoundError("Customer not found");
    const row = await updateCustomer(tenant, id, patch, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "customer.updated",
        resourceType: "customer",
        resourceId: id,
        metadata: { changedFields: Object.keys(patch) },
        requestId,
      },
      tx,
    );
    return row!;
  });
  return customer;
}

/** DELETE = archive (ADR-026), never a physical delete. */
export async function archiveCustomer(tenant: TenantContext, actor: Actor, requestId: string | undefined, id: string) {
  const customer = await db.transaction(async (tx) => {
    const existing = await getCustomer(tenant, id, tx);
    if (!existing) throw new NotFoundError("Customer not found");
    const row = await updateCustomer(tenant, id, { status: "ARCHIVED" }, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "customer.deleted",
        resourceType: "customer",
        resourceId: id,
        requestId,
      },
      tx,
    );
    return row!;
  });
  return customer;
}
