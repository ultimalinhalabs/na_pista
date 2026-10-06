import { and, count, eq, type SQL, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { orderItems, orders } from "../../db/schema/index.js";
import { orderByAllowlisted } from "../../shared/listing.js";

/** tenancy.md §3 layer 3: the only place with SQL for orders/order_items, requires a TenantContext. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update" | "delete">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export type OrderStatus = "DRAFT" | "CONFIRMED" | "COMPLETED" | "CANCELED";

export interface OrderRow {
  id: string;
  organizationId: string;
  customerId: string | null;
  status: OrderStatus;
  currency: string;
  subtotal: string;
  total: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function insertOrder(
  tenant: TenantContext,
  input: { customerId?: string | null; currency: string },
  executor: Executor = db,
): Promise<OrderRow> {
  assertTenant(tenant);
  const [row] = await executor
    .insert(orders)
    .values({ organizationId: tenant.organizationId, customerId: input.customerId ?? null, currency: input.currency })
    .returning();
  return row! as OrderRow;
}

export interface OrderFilters {
  status?: OrderStatus;
  customerId?: string;
  limit: number;
  offset?: number;
  sort?: OrderSort;
  order?: "asc" | "desc";
}

/** ADR-052: public sort name -> column. The only columns a client can sort by. */
export const ORDERS_SORT_COLUMNS = { createdAt: orders.createdAt, updatedAt: orders.updatedAt };
export type OrderSort = keyof typeof ORDERS_SORT_COLUMNS;

/** One WHERE for both the page and its count — `total` can never use a different tenant filter than the rows. */
function ordersConditions(tenant: TenantContext, filters: Omit<OrderFilters, "limit">): SQL | undefined {
  const conditions = [eq(orders.organizationId, tenant.organizationId)];
  if (filters.status) conditions.push(eq(orders.status, filters.status));
  if (filters.customerId) conditions.push(eq(orders.customerId, filters.customerId));
  return and(...conditions);
}

export async function listOrders(tenant: TenantContext, filters: OrderFilters, executor: Executor = db): Promise<OrderRow[]> {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(orders)
    .where(ordersConditions(tenant, filters))
    .orderBy(...orderByAllowlisted(ORDERS_SORT_COLUMNS, orders.id, filters.sort ?? "createdAt", filters.order ?? "desc"))
    .limit(filters.limit)
    .offset(filters.offset ?? 0);
  return rows as OrderRow[];
}

export async function countOrders(tenant: TenantContext, filters: Omit<OrderFilters, "limit">, executor: Executor = db): Promise<number> {
  assertTenant(tenant);
  const [row] = await executor.select({ total: count() }).from(orders).where(ordersConditions(tenant, filters));
  return row?.total ?? 0;
}

/** Another organization's order id resolves to `undefined` — the service layer turns that into 404 (tenancy.md §3). */
export async function getOrder(tenant: TenantContext, id: string, executor: Executor = db): Promise<OrderRow | undefined> {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(orders)
    .where(and(eq(orders.organizationId, tenant.organizationId), eq(orders.id, id)))
    .limit(1);
  return row as OrderRow | undefined;
}

/**
 * Row-locking read (`SELECT ... FOR UPDATE`) — used ONLY by the lifecycle
 * transitions (confirm/cancel/complete, `orders/service.ts`), never by
 * plain reads. A second, concurrent lifecycle request on the SAME Order
 * blocks here until the first transaction commits or rolls back, then
 * observes the now-current status — the same "let Postgres serialize it"
 * philosophy ADR-028 already established for balance mutation, applied to
 * Order.status instead (F23 brief §22/§44: idempotent, race-safe lifecycle
 * transitions). Must only ever be called inside a `db.transaction`.
 */
export async function getOrderForUpdate(tenant: TenantContext, id: string, tx: Executor): Promise<OrderRow | undefined> {
  assertTenant(tenant);
  const [row] = await tx
    .select()
    .from(orders)
    .where(and(eq(orders.organizationId, tenant.organizationId), eq(orders.id, id)))
    .for("update")
    .limit(1);
  return row as OrderRow | undefined;
}

export async function updateOrderStatus(tenant: TenantContext, id: string, status: OrderStatus, executor: Executor = db): Promise<OrderRow> {
  assertTenant(tenant);
  const [row] = await executor
    .update(orders)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(orders.organizationId, tenant.organizationId), eq(orders.id, id)))
    .returning();
  return row! as OrderRow;
}

export async function updateOrderCustomer(tenant: TenantContext, id: string, customerId: string | null, executor: Executor = db): Promise<OrderRow> {
  assertTenant(tenant);
  const [row] = await executor
    .update(orders)
    .set({ customerId, updatedAt: new Date() })
    .where(and(eq(orders.organizationId, tenant.organizationId), eq(orders.id, id)))
    .returning();
  return row! as OrderRow;
}

/**
 * ADR-029: `subtotal`/`total` are recomputed from the actual, currently
 * stored `order_items.subtotal` rows via a SQL `SUM` — never carried
 * forward incrementally in application code, so a total can never drift
 * from what its items actually say (F23 brief §16: "do not preserve stale
 * totals"). `total = subtotal` always in this slice (no tax/discount/
 * shipping yet, F23 brief §7) — both columns are set from the same sum.
 */
export async function recalculateOrderTotals(tenant: TenantContext, orderId: string, executor: Executor = db): Promise<OrderRow> {
  assertTenant(tenant);
  const sumExpr = sql`(select coalesce(sum(${orderItems.subtotal}), 0) from ${orderItems} where ${orderItems.orderId} = ${orderId} and ${orderItems.organizationId} = ${tenant.organizationId})`;
  const [row] = await executor
    .update(orders)
    .set({ subtotal: sumExpr, total: sumExpr, updatedAt: new Date() })
    .where(and(eq(orders.organizationId, tenant.organizationId), eq(orders.id, orderId)))
    .returning();
  return row! as OrderRow;
}

export interface OrderItemRow {
  id: string;
  organizationId: string;
  orderId: string;
  productId: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  subtotal: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * `subtotal` is computed HERE, in SQL, from the snapshotted `unitPrice`
 * and `quantity` — `ROUND(unit_price * quantity, 2)` — never in JS
 * (ADR-029). Postgres's `numeric` arithmetic is exact; `ROUND(numeric, 2)`
 * is confirmed (F23A) to round half-away-from-zero.
 */
export async function insertOrderItem(
  tenant: TenantContext,
  input: { orderId: string; productId: string; productName: string; unitPrice: string; quantity: string },
  executor: Executor = db,
): Promise<OrderItemRow> {
  assertTenant(tenant);
  const [row] = await executor
    .insert(orderItems)
    .values({
      organizationId: tenant.organizationId,
      orderId: input.orderId,
      productId: input.productId,
      productName: input.productName,
      unitPrice: input.unitPrice,
      quantity: input.quantity,
      subtotal: sql`round((${input.unitPrice}::numeric) * (${input.quantity}::numeric), 2)`,
    })
    .returning();
  return row! as OrderItemRow;
}

export async function listOrderItems(tenant: TenantContext, orderId: string, executor: Executor = db): Promise<OrderItemRow[]> {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.organizationId, tenant.organizationId), eq(orderItems.orderId, orderId)))
    .orderBy(orderItems.createdAt);
  return rows as OrderItemRow[];
}

export async function getOrderItem(tenant: TenantContext, orderId: string, itemId: string, executor: Executor = db): Promise<OrderItemRow | undefined> {
  assertTenant(tenant);
  const [row] = await executor
    .select()
    .from(orderItems)
    .where(and(eq(orderItems.organizationId, tenant.organizationId), eq(orderItems.orderId, orderId), eq(orderItems.id, itemId)))
    .limit(1);
  return row as OrderItemRow | undefined;
}

/** Quantity-only change (the price/product snapshot never changes after an item is created) — recomputes `subtotal` in SQL from the item's OWN already-snapshotted `unitPrice`. */
export async function updateOrderItemQuantity(tenant: TenantContext, orderId: string, itemId: string, quantity: string, executor: Executor = db): Promise<OrderItemRow | undefined> {
  assertTenant(tenant);
  const [row] = await executor
    .update(orderItems)
    .set({
      quantity,
      subtotal: sql`round(${orderItems.unitPrice} * (${quantity}::numeric), 2)`,
      updatedAt: new Date(),
    })
    .where(and(eq(orderItems.organizationId, tenant.organizationId), eq(orderItems.orderId, orderId), eq(orderItems.id, itemId)))
    .returning();
  return row as OrderItemRow | undefined;
}

/**
 * Physical delete — the only place in Na Pista's Order/Commerce domain
 * this happens. Safe specifically here because a DRAFT OrderItem has no
 * historical value yet (an Order is only "history" from CONFIRMED
 * onward, ADR-032) — this is cart-editing, not record-keeping. The
 * service layer guards that this only ever runs against a DRAFT Order.
 */
export async function deleteOrderItem(tenant: TenantContext, orderId: string, itemId: string, executor: Executor = db): Promise<void> {
  assertTenant(tenant);
  await executor.delete(orderItems).where(and(eq(orderItems.organizationId, tenant.organizationId), eq(orderItems.orderId, orderId), eq(orderItems.id, itemId)));
}
