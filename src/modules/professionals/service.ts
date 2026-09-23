import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getService } from "../services/repository.js";
import { ConflictError, NotFoundError, ProfessionalArchivedError, ServiceArchivedError, isUniqueViolationError } from "../../shared/errors.js";
import {
  deleteAssociation,
  getProfessional,
  insertAssociation,
  insertProfessional,
  listProfessionals,
  listServicesForProfessional,
  updateProfessional,
  type ProfessionalFilters,
  type TenantContext,
} from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

export async function createProfessional(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { name: string; description?: string; phone?: string; email?: string },
) {
  const professional = await db.transaction(async (tx) => {
    const row = await insertProfessional(tenant, input, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "professional.created",
        resourceType: "professional",
        resourceId: row.id,
        metadata: { name: row.name },
        requestId,
      },
      tx,
    );
    return row;
  });

  // ADR-036/F25A §11: usage recorded on create only, matching Product/
  // Customer/Service's established convention.
  await recordUsage(tenant.organizationId, `professional.created:${professional.id}`, { resourceType: "professional", resourceId: professional.id }, requestId);
  return professional;
}

export async function listAllProfessionals(tenant: TenantContext, filters: ProfessionalFilters) {
  return listProfessionals(tenant, filters);
}

export async function getProfessionalOrThrow(tenant: TenantContext, id: string) {
  const professional = await getProfessional(tenant, id);
  if (!professional) throw new NotFoundError("Professional not found");
  return professional;
}

/**
 * ADR-036 §19: lifecycle transitions go through this SAME `PATCH` path —
 * no dedicated archive/reactivate functions, no `professionals.delete`.
 * The audit ACTION distinguishes a real lifecycle transition from an
 * ordinary field edit, exactly mirroring Service's own logic
 * (`professional.archived`/`professional.reactivated` vs.
 * `professional.updated`).
 */
export async function updateProfessionalOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  id: string,
  patch: { name?: string; description?: string | null; phone?: string | null; email?: string | null; status?: "ACTIVE" | "ARCHIVED" },
) {
  const professional = await db.transaction(async (tx) => {
    const existing = await getProfessional(tenant, id, tx);
    if (!existing) throw new NotFoundError("Professional not found");
    const row = await updateProfessional(tenant, id, patch, tx);

    let action = "professional.updated";
    if (patch.status && patch.status !== existing.status) {
      action = patch.status === "ARCHIVED" ? "professional.archived" : "professional.reactivated";
    }

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action,
        resourceType: "professional",
        resourceId: id,
        metadata: { changedFields: Object.keys(patch) },
        requestId,
      },
      tx,
    );
    return row!;
  });
  return professional;
}

export async function listServicesForProfessionalOrThrow(tenant: TenantContext, professionalId: string) {
  const professional = await getProfessional(tenant, professionalId);
  if (!professional) throw new NotFoundError("Professional not found");
  return listServicesForProfessional(tenant, professionalId);
}

/**
 * ADR-037 — the central F25 mutation. Both sides are re-verified INSIDE
 * the same transaction as the insert (existence + not-ARCHIVED); the
 * insert itself relies on the database's own `UNIQUE(organization_id,
 * professional_id, service_id)` constraint for duplicate prevention —
 * never a separate pre-check-then-insert race — translated to `409
 * CONFLICT` here, never a raw Postgres error.
 */
export async function associateService(tenant: TenantContext, actor: Actor, requestId: string | undefined, professionalId: string, serviceId: string) {
  const association = await db.transaction(async (tx) => {
    const professional = await getProfessional(tenant, professionalId, tx);
    if (!professional) throw new NotFoundError("Professional not found");
    if (professional.status === "ARCHIVED") {
      throw new ProfessionalArchivedError(`Professional "${professional.name}" is archived; cannot create a new service association`);
    }

    const service = await getService(tenant, serviceId, tx);
    if (!service) throw new NotFoundError("Service not found");
    if (service.status === "ARCHIVED") {
      throw new ServiceArchivedError(`Service "${service.name}" is archived; cannot create a new professional association`);
    }

    let row;
    try {
      row = await insertAssociation(tenant, professionalId, serviceId, tx);
    } catch (error) {
      if (isUniqueViolationError(error)) {
        throw new ConflictError(`Professional "${professional.name}" is already associated with service "${service.name}"`);
      }
      throw error;
    }

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "professional_service.created",
        resourceType: "professional_service",
        resourceId: row.id,
        metadata: { professionalId, serviceId },
        requestId,
      },
      tx,
    );
    return row;
  });
  return association;
}

/** ADR-037: disassociation is always allowed regardless of either side's ARCHIVED status — narrowing what exists is never a new capability. A physical delete of the join row; `404` if no such association exists. */
export async function removeAssociation(tenant: TenantContext, actor: Actor, requestId: string | undefined, professionalId: string, serviceId: string) {
  await db.transaction(async (tx) => {
    const professional = await getProfessional(tenant, professionalId, tx);
    if (!professional) throw new NotFoundError("Professional not found");

    const deleted = await deleteAssociation(tenant, professionalId, serviceId, tx);
    if (!deleted) throw new NotFoundError("Service association not found");

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "professional_service.removed",
        resourceType: "professional_service",
        resourceId: deleted.id,
        metadata: { professionalId, serviceId },
        requestId,
      },
      tx,
    );
  });
}
