import { db } from "../../db/index.js";
import { recordUsage } from "../../platform/usage.js";
import { recordAuditEvent } from "../audit/service.js";
import { getCustomer } from "../customers/repository.js";
import { getProduct } from "../products/repository.js";
import { createMovement } from "../inventory/service.js";
import {
  CustomerArchivedError,
  EmptyOrderError,
  InvalidOrderStateError,
  NotFoundError,
  OrderNotFoundError,
  ProductArchivedError,
  ProductNotFoundError,
  ProductPriceRequiredError,
} from "../../shared/errors.js";
import {
  deleteOrderItem,
  getOrder,
  getOrderForUpdate,
  getOrderItem,
  insertOrder,
  insertOrderItem,
  listOrderItems,
  listOrders,
  recalculateOrderTotals,
  updateOrderCustomer,
  updateOrderItemQuantity,
  updateOrderStatus,
  type OrderFilters,
  type OrderRow,
  type TenantContext,
} from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

type Tx = Pick<typeof db, "insert" | "select" | "update" | "delete">;

/**
 * F23A (ADR-030): a real `TenantSettings`/organization-currency table does
 * not exist yet (confirmed: `src/db/schema/` has no such table). Using the
 * F23A-approved single supported currency directly, rather than inventing
 * a settings subsystem this phase doesn't need — documented as a known
 * limitation in `docs/f23-report.md`, not silently assumed. The moment a
 * real per-organization currency setting exists, this is the one line
 * that changes; `Order.currency` already snapshots whatever it resolves
 * to, so nothing else in this module needs to change.
 */
const DEFAULT_CURRENCY = "AOA";

/** F23 brief §5/§36: a product must exist, be ACTIVE, and have a price to be added to an Order — enforced at the moment an item is created, not on every subsequent read. */
async function resolveOrderableProduct(tenant: TenantContext, productId: string, executor: Tx) {
  const product = await getProduct(tenant, productId, executor);
  if (!product) throw new ProductNotFoundError();
  if (product.status === "ARCHIVED") {
    throw new ProductArchivedError(`Product "${product.name}" is archived; cannot be added to an Order`);
  }
  if (product.price === null) {
    throw new ProductPriceRequiredError(`Product "${product.name}" has no price set; cannot be added to an Order`);
  }
  return product;
}

/** F23 brief §37: a NEW Order (or a DRAFT Order's customer change) may not select an archived Customer; historical references are untouched by this check. */
async function resolveOrderableCustomer(tenant: TenantContext, customerId: string, executor: Tx) {
  const customer = await getCustomer(tenant, customerId, executor);
  if (!customer) throw new NotFoundError("Customer not found");
  if (customer.status === "ARCHIVED") throw new CustomerArchivedError();
  return customer;
}

/** Shared guard for every DRAFT-only mutation (item add/remove/quantity-change, customer change) — locks the Order row (blocks a concurrent lifecycle transition on the SAME Order) and confirms it is still editable. */
async function requireDraftOrderForUpdate(tenant: TenantContext, orderId: string, tx: Tx): Promise<OrderRow> {
  const order = await getOrderForUpdate(tenant, orderId, tx);
  if (!order) throw new OrderNotFoundError();
  if (order.status !== "DRAFT") {
    throw new InvalidOrderStateError(`Order is not editable in its current state (${order.status}) — only DRAFT Orders can be changed`);
  }
  return order;
}

async function withItems(tenant: TenantContext, order: OrderRow, executor: Tx = db) {
  const items = await listOrderItems(tenant, order.id, executor);
  return { ...order, items };
}

/**
 * F23 brief §13: the client supplies only `customerId?`/`items[].
 * {productId, quantity}` — `unitPrice`/`productName`/`subtotal`/`total`/
 * `currency` are always resolved server-side (ADR-031), inside one
 * transaction, so a client can never manipulate price or total.
 */
export async function createOrder(
  tenant: TenantContext,
  actor: Actor,
  requestId: string | undefined,
  input: { customerId?: string; items: { productId: string; quantity: string }[] },
) {
  const result = await db.transaction(async (tx) => {
    if (input.customerId) {
      await resolveOrderableCustomer(tenant, input.customerId, tx);
    }

    const order = await insertOrder(tenant, { customerId: input.customerId ?? null, currency: DEFAULT_CURRENCY }, tx);

    for (const item of input.items) {
      const product = await resolveOrderableProduct(tenant, item.productId, tx);
      await insertOrderItem(
        tenant,
        { orderId: order.id, productId: product.id, productName: product.name, unitPrice: product.price!, quantity: item.quantity },
        tx,
      );
    }

    const finalOrder = input.items.length > 0 ? await recalculateOrderTotals(tenant, order.id, tx) : order;

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.created",
        resourceType: "order",
        resourceId: order.id,
        metadata: { itemCount: input.items.length, customerId: input.customerId ?? null },
        requestId,
      },
      tx,
    );

    return withItems(tenant, finalOrder, tx);
  });

  await recordUsage(tenant.organizationId, `order.created:${result.id}`, { resourceType: "order", resourceId: result.id }, requestId);
  return result;
}

export async function listAllOrders(tenant: TenantContext, filters: OrderFilters) {
  return listOrders(tenant, filters);
}

export async function getOrderOrThrow(tenant: TenantContext, id: string) {
  const order = await getOrder(tenant, id);
  if (!order) throw new OrderNotFoundError();
  return withItems(tenant, order);
}

/** DRAFT-only (F23 brief §16/§23). Currently the only field editable this way is `customerId` — item changes go through their own endpoints. */
export async function updateOrderCustomerOrThrow(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string, customerId: string | null) {
  const result = await db.transaction(async (tx) => {
    await requireDraftOrderForUpdate(tenant, orderId, tx);
    if (customerId) {
      await resolveOrderableCustomer(tenant, customerId, tx);
    }
    const order = await updateOrderCustomer(tenant, orderId, customerId, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.updated",
        resourceType: "order",
        resourceId: orderId,
        metadata: { changedFields: ["customerId"] },
        requestId,
      },
      tx,
    );
    return withItems(tenant, order, tx);
  });
  return result;
}

/** F23 brief §16: adding an item to a DRAFT Order recalculates totals — never a stale total. */
export async function addOrderItem(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string, input: { productId: string; quantity: string }) {
  const result = await db.transaction(async (tx) => {
    await requireDraftOrderForUpdate(tenant, orderId, tx);
    const product = await resolveOrderableProduct(tenant, input.productId, tx);
    await insertOrderItem(
      tenant,
      { orderId, productId: product.id, productName: product.name, unitPrice: product.price!, quantity: input.quantity },
      tx,
    );
    const order = await recalculateOrderTotals(tenant, orderId, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.updated",
        resourceType: "order",
        resourceId: orderId,
        metadata: { changedFields: ["items"], operation: "item_added", productId: product.id },
        requestId,
      },
      tx,
    );
    return withItems(tenant, order, tx);
  });
  return result;
}

export async function updateOrderItemQuantityOrThrow(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string, itemId: string, quantity: string) {
  const result = await db.transaction(async (tx) => {
    await requireDraftOrderForUpdate(tenant, orderId, tx);
    const existing = await getOrderItem(tenant, orderId, itemId, tx);
    if (!existing) throw new NotFoundError("Order item not found");
    await updateOrderItemQuantity(tenant, orderId, itemId, quantity, tx);
    const order = await recalculateOrderTotals(tenant, orderId, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.updated",
        resourceType: "order",
        resourceId: orderId,
        metadata: { changedFields: ["items"], operation: "item_quantity_changed", productId: existing.productId },
        requestId,
      },
      tx,
    );
    return withItems(tenant, order, tx);
  });
  return result;
}

export async function removeOrderItemOrThrow(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string, itemId: string) {
  const result = await db.transaction(async (tx) => {
    await requireDraftOrderForUpdate(tenant, orderId, tx);
    const existing = await getOrderItem(tenant, orderId, itemId, tx);
    if (!existing) throw new NotFoundError("Order item not found");
    await deleteOrderItem(tenant, orderId, itemId, tx);
    const order = await recalculateOrderTotals(tenant, orderId, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.updated",
        resourceType: "order",
        resourceId: orderId,
        metadata: { changedFields: ["items"], operation: "item_removed", productId: existing.productId },
        requestId,
      },
      tx,
    );
    return withItems(tenant, order, tx);
  });
  return result;
}

/**
 * F23 brief §17/§19/§42/§43 — the critical transactional boundary.
 * `getOrderForUpdate` (`SELECT ... FOR UPDATE`) makes a second, racing
 * confirm/cancel/complete request on THIS SAME Order block until this
 * transaction resolves, then observe the real, current status (idempotent
 * by construction — F23 brief §22/§44). Each item's stock decrease reuses
 * `createMovement` UNCHANGED (F23 brief §18), passed THIS transaction
 * (`tx`) so Order status + every StockMovement + the audit event commit
 * or roll back together, atomically (F23 brief §19). Cross-Order races for
 * the SAME product (F23 brief §42) are resolved by `createMovement`'s own
 * proven atomic conditional UPDATE on `inventory_balances` (ADR-028) —
 * nothing new to prove here, only to reuse.
 */
export async function confirmOrder(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string) {
  const result = await db.transaction(async (tx) => {
    const order = await getOrderForUpdate(tenant, orderId, tx);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "DRAFT") {
      throw new InvalidOrderStateError(`Cannot confirm an Order in status ${order.status}`);
    }

    const items = await listOrderItems(tenant, orderId, tx);
    if (items.length === 0) throw new EmptyOrderError();

    // Product ACTIVE/existence re-check happens for free inside
    // createMovement (ADR-028) — an item whose Product was archived after
    // being added to this DRAFT fails confirmation here with
    // PRODUCT_ARCHIVED (F23 brief §36), rolling back everything above.
    for (const item of items) {
      await createMovement(
        tenant,
        actor,
        requestId,
        item.productId,
        { type: "ADJUSTMENT_OUT", quantity: item.quantity, reason: `Order ${orderId} confirmed` },
        tx,
      );
    }

    const updated = await updateOrderStatus(tenant, orderId, "CONFIRMED", tx);

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.confirmed",
        resourceType: "order",
        resourceId: orderId,
        metadata: { itemCount: items.length },
        requestId,
      },
      tx,
    );

    return withItems(tenant, updated, tx);
  });

  await recordUsage(tenant.organizationId, `order.confirmed:${orderId}`, { resourceType: "order", resourceId: orderId }, requestId);
  return result;
}

/**
 * F23 brief §20 — DRAFT -> CANCELED never touches Inventory (nothing was
 * ever consumed). CONFIRMED -> CANCELED reverses exactly the stock this
 * Order consumed at confirmation, via the existing ADJUSTMENT_IN movement
 * type (no new RETURN type invented, ADR-032). Idempotent by the same
 * row-lock construction as `confirmOrder` — a second cancel on an already
 * CANCELED Order sees the real current status and fails, never
 * double-reversing stock.
 */
export async function cancelOrder(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string) {
  const result = await db.transaction(async (tx) => {
    const order = await getOrderForUpdate(tenant, orderId, tx);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "DRAFT" && order.status !== "CONFIRMED") {
      throw new InvalidOrderStateError(`Cannot cancel an Order in status ${order.status}`);
    }
    const wasConfirmed = order.status === "CONFIRMED";

    if (wasConfirmed) {
      const items = await listOrderItems(tenant, orderId, tx);
      for (const item of items) {
        await createMovement(
          tenant,
          actor,
          requestId,
          item.productId,
          { type: "ADJUSTMENT_IN", quantity: item.quantity, reason: `Order ${orderId} canceled` },
          tx,
        );
      }
    }

    const updated = await updateOrderStatus(tenant, orderId, "CANCELED", tx);

    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.canceled",
        resourceType: "order",
        resourceId: orderId,
        metadata: { fromStatus: order.status, inventoryReversed: wasConfirmed },
        requestId,
      },
      tx,
    );

    return withItems(tenant, updated, tx);
  });

  await recordUsage(tenant.organizationId, `order.canceled:${orderId}`, { resourceType: "order", resourceId: orderId }, requestId);
  return result;
}

/** F23 brief §21 — CONFIRMED -> COMPLETED changes only lifecycle state; stock was already consumed at confirmation and is never touched again. */
export async function completeOrder(tenant: TenantContext, actor: Actor, requestId: string | undefined, orderId: string) {
  const result = await db.transaction(async (tx) => {
    const order = await getOrderForUpdate(tenant, orderId, tx);
    if (!order) throw new OrderNotFoundError();
    if (order.status !== "CONFIRMED") {
      throw new InvalidOrderStateError(`Cannot complete an Order in status ${order.status}`);
    }
    const updated = await updateOrderStatus(tenant, orderId, "COMPLETED", tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "order.completed",
        resourceType: "order",
        resourceId: orderId,
        requestId,
      },
      tx,
    );
    return withItems(tenant, updated, tx);
  });

  await recordUsage(tenant.organizationId, `order.completed:${orderId}`, { resourceType: "order", resourceId: orderId }, requestId);
  return result;
}
