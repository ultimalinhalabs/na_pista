import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getProduct } from "../products/repository.js";
import { InsufficientStockError, InventoryNotFoundError, ProductArchivedError, ProductNotFoundError } from "../../shared/errors.js";
import {
  decreaseBalance,
  getBalance,
  increaseBalance,
  insertMovement,
  listBalances,
  listMovements,
  type BalanceWithProduct,
  type MovementRow,
  type TenantContext,
} from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

export type MovementType = "RECEIPT" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT";

const AUDIT_ACTION: Record<MovementType, string> = {
  RECEIPT: "inventory.receipt",
  ADJUSTMENT_IN: "inventory.adjustment_in",
  ADJUSTMENT_OUT: "inventory.adjustment_out",
};

export async function listAllBalances(tenant: TenantContext, filters: { zeroStock?: boolean; limit: number }) {
  return listBalances(tenant, filters);
}

export async function getBalanceOrThrow(tenant: TenantContext, productId: string): Promise<BalanceWithProduct> {
  // A product that genuinely doesn't exist in this tenant is a different
  // error than "exists but was never stocked" (F22 brief §30).
  const product = await getProduct(tenant, productId);
  if (!product) throw new ProductNotFoundError();
  const balance = await getBalance(tenant, productId);
  if (!balance) throw new InventoryNotFoundError();
  return balance;
}

export async function listAllMovements(tenant: TenantContext, productId: string, filters: { limit: number }): Promise<MovementRow[]> {
  const product = await getProduct(tenant, productId);
  if (!product) throw new ProductNotFoundError();
  return listMovements(tenant, productId, filters);
}

/**
 * ADR-028: the one transaction that establishes F22's core invariant —
 * a stock movement and its balance update happen together, or neither
 * happens. Product existence/archived-state check happens INSIDE the
 * same transaction (F22 brief §22): an archived product never receives
 * a new movement, but its existing balance/history stay fully intact
 * and readable (nothing here ever touches a product row).
 */
export async function createMovement(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  productId: string,
  input: { type: MovementType; quantity: string; reason?: string },
) {
  const result = await db.transaction(async (tx) => {
    const product = await getProduct(tenant, productId, tx);
    if (!product) throw new ProductNotFoundError();
    if (product.status === "ARCHIVED") {
      throw new ProductArchivedError(`Product "${product.name}" is archived; cannot record a new inventory movement`);
    }

    const balance =
      input.type === "ADJUSTMENT_OUT"
        ? await decreaseBalance(tenant, productId, input.quantity, tx)
        : await increaseBalance(tenant, productId, input.quantity, tx);

    if (!balance) {
      // Only reachable for ADJUSTMENT_OUT (increaseBalance always
      // succeeds via upsert) — the WHERE guard found insufficient (or
      // zero/non-existent) stock. No row was touched; the transaction
      // has nothing to roll back for the balance itself, but we still
      // throw before inserting a movement, so no orphaned movement is
      // ever created either.
      throw new InsufficientStockError(`Insufficient stock for product "${product.name}"`);
    }

    const movement = await insertMovement(
      tenant,
      {
        inventoryId: balance.id,
        productId,
        type: input.type,
        quantity: input.quantity,
        reason: input.reason,
        actorType: actor.type,
        actorId: actor.id,
      },
      tx,
    );

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: AUDIT_ACTION[input.type],
        resourceType: "inventory_movement",
        resourceId: movement.id,
        metadata: { productId, type: input.type, quantity: input.quantity },
        requestId,
      },
      tx,
    );

    return { balance, movement };
  });

  await recordUsage(tenant.organizationId, `inventory.movement:${result.movement.id}`, { resourceType: "inventory_movement", resourceId: result.movement.id }, requestId);

  return result;
}
