import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getProduct } from "../products/repository.js";
import { InsufficientStockError, InventoryNotFoundError, ProductArchivedError, ProductNotFoundError } from "../../shared/errors.js";
import { pageRequest, type Page } from "../../shared/listing.js";
import {
  countBalances,
  countMovements,
  decreaseBalance,
  getBalance,
  increaseBalance,
  insertMovement,
  listBalances,
  listMovements,
  type BalanceFilters,
  type BalanceRow,
  type BalanceWithProduct,
  type MovementRow,
  type TenantContext,
} from "./repository.js";
import { INVENTORY_DEFAULT_PAGE_SIZE, MOVEMENTS_DEFAULT_PAGE_SIZE, type ListInventoryQuery, type ListMovementsQuery } from "./schemas.js";

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

export async function listAllBalances(tenant: TenantContext, filters: BalanceFilters) {
  return listBalances(tenant, filters);
}

/** ADR-051: one page + the tenant-scoped total for the same filters. */
export async function listBalancesPage(tenant: TenantContext, query: ListInventoryQuery): Promise<Page<BalanceWithProduct>> {
  const { page, pageSize, offset } = pageRequest(query, INVENTORY_DEFAULT_PAGE_SIZE);
  const { page: _p, pageSize: _s, limit: _l, ...filters } = query;
  const [items, total] = await Promise.all([listBalances(tenant, { ...filters, limit: pageSize, offset }), countBalances(tenant, filters)]);
  return { items, page, pageSize, total };
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

export async function listAllMovements(tenant: TenantContext, productId: string, filters: { limit: number; offset?: number }): Promise<MovementRow[]> {
  const product = await getProduct(tenant, productId);
  if (!product) throw new ProductNotFoundError();
  return listMovements(tenant, productId, filters);
}

/** ADR-051: one page of a product's movements + their total. PRODUCT_NOT_FOUND first, as before. */
export async function listMovementsPage(tenant: TenantContext, productId: string, query: ListMovementsQuery): Promise<Page<MovementRow>> {
  const { page, pageSize, offset } = pageRequest(query, MOVEMENTS_DEFAULT_PAGE_SIZE);
  const product = await getProduct(tenant, productId);
  if (!product) throw new ProductNotFoundError();
  const [items, total] = await Promise.all([listMovements(tenant, productId, { limit: pageSize, offset }), countMovements(tenant, productId)]);
  return { items, page, pageSize, total };
}

/** Structurally the same executor shape every repository function already accepts (`Pick<typeof db, ...>`) — a transaction (`tx`) satisfies this. */
type Tx = Pick<typeof db, "insert" | "select" | "update">;

/**
 * ADR-028: the one transaction that establishes F22's core invariant —
 * a stock movement and its balance update happen together, or neither
 * happens. Product existence/archived-state check happens INSIDE the
 * same transaction (F22 brief §22): an archived product never receives
 * a new movement, but its existing balance/history stay fully intact
 * and readable (nothing here ever touches a product row).
 *
 * F23 (brief §18/§43): Order confirmation needs this exact mutation to
 * participate in ITS OWN outer transaction (Order status change + stock
 * movements + audit, all-or-nothing) — without duplicating this logic
 * inside Orders and without bypassing this service to touch
 * `inventory_balances`/`stock_movements` directly (F23 brief §18's
 * explicit instruction). The minimal refactor: an optional `externalTx`
 * parameter. When provided, this function runs its body against that
 * transaction directly (no nested `BEGIN` — the caller's transaction is
 * the only one, so a rollback anywhere in the caller rolls this back too)
 * and leaves usage-recording to the caller, since recording usage before
 * the OUTER transaction commits could record it for a movement that still
 * might roll back if a later step in the caller's own flow fails. Every
 * existing caller (the standalone `POST .../movements` route, every F22
 * test) passes no `externalTx` and gets byte-for-byte the same behavior
 * as before this change — own transaction, own usage recording.
 */
export async function createMovement(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  productId: string,
  input: { type: MovementType; quantity: string; reason?: string },
  externalTx?: Tx,
): Promise<{ balance: BalanceRow; movement: MovementRow }> {
  const run = async (tx: Tx) => {
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
  };

  if (externalTx) {
    return run(externalTx);
  }

  const result = await db.transaction(run);
  await recordUsage(tenant.organizationId, `inventory.movement:${result.movement.id}`, { resourceType: "inventory_movement", resourceId: result.movement.id }, requestId);
  return result;
}
