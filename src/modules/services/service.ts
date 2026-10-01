import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { NotFoundError } from "../../shared/errors.js";
import {
  countServices,
  getService,
  insertService,
  listServices,
  updateService,
  type ServiceFilters,
  type TenantContext,
} from "./repository.js";
import { SERVICES_DEFAULT_PAGE_SIZE, type ListServicesQuery } from "./schemas.js";
import { pageRequest, type Page } from "../../shared/listing.js";

type ServiceItem = Awaited<ReturnType<typeof listServices>>[number];

export interface Actor {
  type: "user" | "service";
  id: string;
}

export async function createService(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { name: string; description?: string; durationMinutes: number; price?: string },
) {
  const service = await db.transaction(async (tx) => {
    const row = await insertService(tenant, input, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "service.created",
        resourceType: "service",
        resourceId: row.id,
        metadata: { name: row.name, durationMinutes: row.durationMinutes },
        requestId,
      },
      tx,
    );
    return row;
  });

  // F24A/ADR-033 §17: usage recorded on create only, matching Product/
  // Customer's established convention (a simple two-state lifecycle, not
  // a multi-stage process like Order/Inventory's own per-event recording).
  await recordUsage(tenant.organizationId, `service.created:${service.id}`, { resourceType: "service", resourceId: service.id }, requestId);
  return service;
}

export async function listAllServices(tenant: TenantContext, filters: ServiceFilters) {
  return listServices(tenant, filters);
}

/** ADR-051: one page + the tenant-scoped total for the same filters. */
export async function listServicesPage(tenant: TenantContext, query: ListServicesQuery): Promise<Page<ServiceItem>> {
  const { page, pageSize, offset } = pageRequest(query, SERVICES_DEFAULT_PAGE_SIZE);
  const { page: _p, pageSize: _s, limit: _l, ...filters } = query;
  const [items, total] = await Promise.all([
    listServices(tenant, { ...filters, limit: pageSize, offset }),
    countServices(tenant, filters),
  ]);
  return { items, page, pageSize, total };
}

export async function getServiceOrThrow(tenant: TenantContext, id: string) {
  const service = await getService(tenant, id);
  if (!service) throw new NotFoundError("Service not found");
  return service;
}

/**
 * F24A/ADR-033 §19: lifecycle transitions go through this SAME `PATCH`
 * path — no dedicated archive/reactivate service functions, no
 * `services.delete`. The audit ACTION name still distinguishes a real
 * lifecycle transition from an ordinary field edit (F24 brief §13/§14):
 * `service.archived`/`service.reactivated` when `status` is the field
 * that actually changed direction, `service.updated` otherwise — audit
 * describes what happened business-wise, not which endpoint was called.
 */
export async function updateServiceOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  id: string,
  patch: { name?: string; description?: string | null; durationMinutes?: number; price?: string | null; status?: "ACTIVE" | "ARCHIVED" },
) {
  const service = await db.transaction(async (tx) => {
    const existing = await getService(tenant, id, tx);
    if (!existing) throw new NotFoundError("Service not found");
    const row = await updateService(tenant, id, patch, tx);

    let action = "service.updated";
    if (patch.status && patch.status !== existing.status) {
      action = patch.status === "ARCHIVED" ? "service.archived" : "service.reactivated";
    }

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action,
        resourceType: "service",
        resourceId: id,
        metadata: { changedFields: Object.keys(patch) },
        requestId,
      },
      tx,
    );
    return row!;
  });
  return service;
}
