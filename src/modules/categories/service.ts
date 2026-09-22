import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { NotFoundError } from "../../shared/errors.js";
import {
  getCategory,
  insertCategory,
  listCategories,
  updateCategory,
  type TenantContext,
} from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

export async function createCategory(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { name: string; description?: string },
) {
  const category = await db.transaction(async (tx) => {
    const row = await insertCategory(tenant, input, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "category.created",
        resourceType: "category",
        resourceId: row.id,
        metadata: { name: row.name },
        requestId,
      },
      tx,
    );
    return row;
  });

  await recordUsage(tenant.organizationId, `category.created:${category.id}`, { resourceType: "category", resourceId: category.id }, requestId);
  return category;
}

export async function listAllCategories(tenant: TenantContext, filters: { status?: "ACTIVE" | "ARCHIVED"; limit: number }) {
  return listCategories(tenant, filters);
}

export async function getCategoryOrThrow(tenant: TenantContext, id: string) {
  const category = await getCategory(tenant, id);
  if (!category) throw new NotFoundError("Category not found");
  return category;
}

export async function updateCategoryOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  id: string,
  patch: { name?: string; description?: string | null; status?: "ACTIVE" | "ARCHIVED" },
) {
  const category = await db.transaction(async (tx) => {
    const existing = await getCategory(tenant, id, tx);
    if (!existing) throw new NotFoundError("Category not found");
    const row = await updateCategory(tenant, id, patch, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "category.updated",
        resourceType: "category",
        resourceId: id,
        metadata: { changedFields: Object.keys(patch) },
        requestId,
      },
      tx,
    );
    return row!;
  });
  return category;
}

/** DELETE = archive (ADR-020), never a physical delete. Audited as `category.deleted` — that IS the operation the caller asked for, even though the effect is a status change. */
export async function archiveCategory(tenant: TenantContext, actor: Actor, requestId: string | undefined, id: string) {
  const category = await db.transaction(async (tx) => {
    const existing = await getCategory(tenant, id, tx);
    if (!existing) throw new NotFoundError("Category not found");
    const row = await updateCategory(tenant, id, { status: "ARCHIVED" }, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "category.deleted",
        resourceType: "category",
        resourceId: id,
        requestId,
      },
      tx,
    );
    return row!;
  });
  return category;
}
