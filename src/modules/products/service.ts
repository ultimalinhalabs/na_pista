import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getCategory } from "../categories/repository.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import { getProduct, insertProduct, listProducts, updateProduct, type ProductFilters, type TenantContext } from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

/**
 * F20 brief §15: a product can never reference a category from another
 * tenant. The composite FK (products_category_org_fk) is the last-resort
 * database guarantee; this check exists so a wrong/foreign categoryId
 * fails as a clean, expected 400 VALIDATION_ERROR instead of a raw
 * Postgres foreign-key-violation surfacing as an opaque 500.
 */
async function assertCategoryBelongsToTenant(tenant: TenantContext, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const category = await getCategory(tenant, categoryId);
  if (!category) {
    throw new ValidationError(`Invalid categoryId: no such category in this organization`);
  }
}

export async function createProduct(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { name: string; description?: string; categoryId?: string },
) {
  await assertCategoryBelongsToTenant(tenant, input.categoryId);

  const product = await db.transaction(async (tx) => {
    const row = await insertProduct(tenant, input, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "product.created",
        resourceType: "product",
        resourceId: row.id,
        metadata: { name: row.name, categoryId: row.categoryId },
        requestId,
      },
      tx,
    );
    return row;
  });

  await recordUsage(tenant.organizationId, `product.created:${product.id}`, { resourceType: "product", resourceId: product.id }, requestId);
  return product;
}

export async function listAllProducts(tenant: TenantContext, filters: ProductFilters) {
  return listProducts(tenant, filters);
}

export async function getProductOrThrow(tenant: TenantContext, id: string) {
  const product = await getProduct(tenant, id);
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

export async function updateProductOrThrow(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  id: string,
  patch: { name?: string; description?: string | null; categoryId?: string | null; status?: "ACTIVE" | "ARCHIVED" },
) {
  if (patch.categoryId !== undefined) {
    await assertCategoryBelongsToTenant(tenant, patch.categoryId);
  }

  const product = await db.transaction(async (tx) => {
    const existing = await getProduct(tenant, id, tx);
    if (!existing) throw new NotFoundError("Product not found");
    const row = await updateProduct(tenant, id, patch, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "product.updated",
        resourceType: "product",
        resourceId: id,
        metadata: { changedFields: Object.keys(patch) },
        requestId,
      },
      tx,
    );
    return row!;
  });
  return product;
}

/** DELETE = archive (ADR-020), never a physical delete — a future Orders module needs to still resolve historical line items. */
export async function archiveProduct(tenant: TenantContext, actor: Actor, requestId: string | undefined, id: string) {
  const product = await db.transaction(async (tx) => {
    const existing = await getProduct(tenant, id, tx);
    if (!existing) throw new NotFoundError("Product not found");
    const row = await updateProduct(tenant, id, { status: "ARCHIVED" }, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "product.deleted",
        resourceType: "product",
        resourceId: id,
        requestId,
      },
      tx,
    );
    return row!;
  });
  return product;
}
