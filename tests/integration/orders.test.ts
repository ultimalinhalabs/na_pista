import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { db, queryClient } from "../../src/db/index.js";
import { orderItems } from "../../src/db/schema/index.js";
import { insertProduct, updateProduct } from "../../src/modules/products/repository.js";
import { insertCustomer, updateCustomer } from "../../src/modules/customers/repository.js";
import { getBalance, listMovements } from "../../src/modules/inventory/repository.js";
import {
  addOrderItem,
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  getOrderOrThrow,
  listAllOrders,
  removeOrderItemOrThrow,
  updateOrderCustomerOrThrow,
  updateOrderItemQuantityOrThrow,
} from "../../src/modules/orders/service.js";
import {
  CustomerArchivedError,
  EmptyOrderError,
  InsufficientStockError,
  InvalidOrderStateError,
  NotFoundError,
  ProductArchivedError,
  ProductNotFoundError,
  ProductPriceRequiredError,
} from "../../src/shared/errors.js";

/** F23 brief §41 "Integration tests", real PostgreSQL, no HTTP, no Platform. */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };
const actor = { type: "user" as const, id: "test-actor" };

after(() => queryClient.end());

async function pricedProduct(org: typeof orgA, name: string, price: string) {
  return insertProduct(org, { name, price });
}

test("1-4/6/7: creating an Order with items snapshots productName/unitPrice, computes exact rounded line subtotal and order total", async () => {
  const product = await pricedProduct(orgA, "Camisola Snapshot", "2.00");
  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "0.0625" }] });

  assert.equal(order.items.length, 1);
  assert.equal(order.items[0]!.productName, "Camisola Snapshot");
  assert.equal(order.items[0]!.unitPrice, "2.00");
  assert.equal(order.items[0]!.quantity, "0.062500");
  // F23A ADR-029: exact tie case (2.00 * 0.0625 = 0.125 exactly), round-half-away-from-zero -> 0.13.
  assert.equal(order.items[0]!.subtotal, "0.13");
  assert.equal(order.subtotal, "0.13");
  assert.equal(order.total, "0.13");
  assert.equal(order.total, order.subtotal, "total = subtotal, no tax/discount/shipping in F23");
  assert.equal(order.currency, "AOA");
  assert.equal(order.status, "DRAFT");
});

test("5: monetary precision — multi-item order sums exactly, never a float artifact", async () => {
  const p1 = await pricedProduct(orgA, "Produto A", "999.99");
  const p2 = await pricedProduct(orgA, "Produto B", "0.01");
  const order = await createOrder(orgA, actor, "req-1", {
    items: [
      { productId: p1.id, quantity: "3" },
      { productId: p2.id, quantity: "1" },
    ],
  });
  // 999.99*3 = 2999.97, + 0.01 = 2999.98 — exact, no 2999.9799999999997-style float artifact.
  assert.equal(order.subtotal, "2999.98");
  assert.equal(order.total, "2999.98");
});

test("8: DRAFT editing — add item, change quantity, remove item, change customer, all recalculate totals (never stale)", async () => {
  const customer1 = await insertCustomer(orgA, { name: "Cliente 1" });
  const customer2 = await insertCustomer(orgA, { name: "Cliente 2" });
  const product = await pricedProduct(orgA, "Produto Editável", "10.00");
  const other = await pricedProduct(orgA, "Produto Extra", "5.00");

  let order = await createOrder(orgA, actor, "req-1", { customerId: customer1.id, items: [{ productId: product.id, quantity: "2" }] });
  assert.equal(order.total, "20.00");

  order = await addOrderItem(orgA, actor, "req-2", order.id, { productId: other.id, quantity: "1" });
  assert.equal(order.items.length, 2);
  assert.equal(order.total, "25.00");

  const itemToUpdate = order.items.find((i) => i.productId === product.id)!;
  order = await updateOrderItemQuantityOrThrow(orgA, actor, "req-3", order.id, itemToUpdate.id, "5");
  assert.equal(order.total, "55.00"); // 10*5 + 5*1

  const itemToRemove = order.items.find((i) => i.productId === other.id)!;
  order = await removeOrderItemOrThrow(orgA, actor, "req-4", order.id, itemToRemove.id);
  assert.equal(order.items.length, 1);
  assert.equal(order.total, "50.00");

  order = await updateOrderCustomerOrThrow(orgA, actor, "req-5", order.id, customer2.id);
  assert.equal(order.customerId, customer2.id);

  order = await updateOrderCustomerOrThrow(orgA, actor, "req-6", order.id, null);
  assert.equal(order.customerId, null, "customer can be cleared back to anonymous while DRAFT");
});

test("9/14: confirmation changes status to CONFIRMED, decreases inventory, and creates one ADJUSTMENT_OUT movement per item", async () => {
  const product = await pricedProduct(orgA, "Produto Confirmar", "50.00");
  await import("../../src/modules/inventory/service.js").then((m) => m.createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "20.000000" }));

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "3" }] });
  const confirmed = await confirmOrder(orgA, actor, "req-2", order.id);

  assert.equal(confirmed.status, "CONFIRMED");

  const balance = await getBalance(orgA, product.id);
  assert.equal(balance?.quantity, "17.000000", "20 - 3 = 17");

  const movements = await listMovements(orgA, product.id, { limit: 10 });
  const orderMovements = movements.filter((m) => m.type === "ADJUSTMENT_OUT" && m.reason?.includes(order.id));
  assert.equal(orderMovements.length, 1);
  assert.equal(orderMovements[0]!.quantity, "3.000000");
});

test("10: completion (CONFIRMED -> COMPLETED) does not consume stock a second time", async () => {
  const product = await pricedProduct(orgA, "Produto Completar", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "4" }] });
  await confirmOrder(orgA, actor, "req-2", order.id);
  const balanceAfterConfirm = await getBalance(orgA, product.id);
  const movementsAfterConfirm = await listMovements(orgA, product.id, { limit: 10 });

  const completed = await completeOrder(orgA, actor, "req-3", order.id);
  assert.equal(completed.status, "COMPLETED");

  const balanceAfterComplete = await getBalance(orgA, product.id);
  const movementsAfterComplete = await listMovements(orgA, product.id, { limit: 10 });
  assert.equal(balanceAfterComplete?.quantity, balanceAfterConfirm?.quantity, "completion must not change the balance");
  assert.equal(movementsAfterComplete.length, movementsAfterConfirm.length, "completion must not create a new movement");
});

test("11a: DRAFT -> CANCELED never touches Inventory (nothing was ever consumed)", async () => {
  const product = await pricedProduct(orgA, "Produto Draft Cancel", "10.00");
  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "2" }] });
  const canceled = await cancelOrder(orgA, actor, "req-2", order.id);
  assert.equal(canceled.status, "CANCELED");
  const balance = await getBalance(orgA, product.id);
  assert.equal(balance, undefined, "no balance row was ever created — DRAFT never touched inventory");
});

test("11b: CONFIRMED -> CANCELED reverses exactly the stock consumed, via ADJUSTMENT_IN, never a new RETURN type", async () => {
  const product = await pricedProduct(orgA, "Produto Confirm Cancel", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "6" }] });
  await confirmOrder(orgA, actor, "req-2", order.id);
  const balanceAfterConfirm = await getBalance(orgA, product.id);
  assert.equal(balanceAfterConfirm?.quantity, "4.000000");

  const canceled = await cancelOrder(orgA, actor, "req-3", order.id);
  assert.equal(canceled.status, "CANCELED");

  const balanceAfterCancel = await getBalance(orgA, product.id);
  assert.equal(balanceAfterCancel?.quantity, "10.000000", "cancellation restores exactly what confirmation consumed");

  const movements = await listMovements(orgA, product.id, { limit: 10 });
  assert.ok(movements.some((m) => m.type === "ADJUSTMENT_IN" && m.reason?.includes(order.id)));
  assert.equal(movements.filter((m) => m.type === "RECEIPT" || m.type === "ADJUSTMENT_IN" || m.type === "ADJUSTMENT_OUT").length, 3, "seed RECEIPT + confirm ADJUSTMENT_OUT + cancel ADJUSTMENT_IN, nothing else");
});

test("12: insufficient stock blocks confirmation — Order remains DRAFT, no partial stock change", async () => {
  const product = await pricedProduct(orgA, "Produto Insuficiente", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "5.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "6" }] });
  await assert.rejects(() => confirmOrder(orgA, actor, "req-2", order.id), InsufficientStockError);

  const reloaded = await getOrderOrThrow(orgA, order.id);
  assert.equal(reloaded.status, "DRAFT");
  const balance = await getBalance(orgA, product.id);
  assert.equal(balance?.quantity, "5.000000", "balance untouched after a failed confirmation");
});

test("13: confirmation atomicity — a 2nd item's insufficient stock rolls back the 1st item's ALREADY-applied stock decrease too", async () => {
  const productOk = await pricedProduct(orgA, "Produto Atomico OK", "10.00");
  const productShort = await pricedProduct(orgA, "Produto Atomico Curto", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed-1", productOk.id, { type: "RECEIPT", quantity: "10.000000" });
  await createMovement(orgA, actor, "req-seed-2", productShort.id, { type: "RECEIPT", quantity: "1.000000" });

  const order = await createOrder(orgA, actor, "req-1", {
    items: [
      { productId: productOk.id, quantity: "3" }, // would succeed alone
      { productId: productShort.id, quantity: "5" }, // insufficient
    ],
  });

  await assert.rejects(() => confirmOrder(orgA, actor, "req-2", order.id), InsufficientStockError);

  const reloaded = await getOrderOrThrow(orgA, order.id);
  assert.equal(reloaded.status, "DRAFT", "the whole confirmation attempt must fail, not just the 2nd item");

  const balanceOk = await getBalance(orgA, productOk.id);
  assert.equal(balanceOk?.quantity, "10.000000", "the 1st item's stock decrease must be rolled back too — no partial commit");
  const balanceShort = await getBalance(orgA, productShort.id);
  assert.equal(balanceShort?.quantity, "1.000000");

  const movementsOk = await listMovements(orgA, productOk.id, { limit: 10 });
  assert.equal(movementsOk.filter((m) => m.type === "ADJUSTMENT_OUT").length, 0, "no orphaned movement for the 1st item either");
});

test("15: no duplicate inventory consumption — a 2nd confirm attempt on an already-CONFIRMED Order fails cleanly, balance changes only once", async () => {
  const product = await pricedProduct(orgA, "Produto Duplo Confirm", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "3" }] });
  await confirmOrder(orgA, actor, "req-2", order.id);
  await assert.rejects(() => confirmOrder(orgA, actor, "req-3", order.id), InvalidOrderStateError);

  const balance = await getBalance(orgA, product.id);
  assert.equal(balance?.quantity, "7.000000", "10 - 3, exactly once");
  const movements = await listMovements(orgA, product.id, { limit: 10 });
  assert.equal(movements.filter((m) => m.type === "ADJUSTMENT_OUT").length, 1);
});

test("16: tenant-safe Customer reference — a customer from org B cannot be assigned to an org A Order", async () => {
  const customerB = await insertCustomer(orgB, { name: "Cliente B" });
  await assert.rejects(() => createOrder(orgA, actor, "req-1", { customerId: customerB.id, items: [] }), NotFoundError);
});

test("17: tenant-safe Product reference — a product from org B cannot be added to an org A Order", async () => {
  const productB = await pricedProduct(orgB, "Produto B", "10.00");
  await assert.rejects(() => createOrder(orgA, actor, "req-1", { items: [{ productId: productB.id, quantity: "1" }] }), ProductNotFoundError);
});

test("18: composite FK rejects an order_items row pointing at a product from a different organization", async () => {
  const order = await createOrder(orgA, actor, "req-1", { items: [] });
  const productInA = await pricedProduct(orgA, "Produto FK Probe", "1.00");
  const err = await db
    .insert(orderItems)
    .values({
      organizationId: orgB.organizationId,
      orderId: order.id,
      productId: productInA.id,
      productName: "x",
      unitPrice: "1.00",
      quantity: "1.000000",
      subtotal: "1.00",
    })
    .catch((e) => e);
  assert.ok(err instanceof Error);
  const cause = err.cause instanceof Error ? err.cause.message : String(err);
  assert.match(cause, /foreign key|violat/i);
});

test("19: audit failure inside the confirmation transaction rolls back the status change AND the stock movement together", async () => {
  const product = await pricedProduct(orgA, "Produto Audit Rollback", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "4" }] });

  const { recordAuditEvent } = await import("../../src/modules/audit/service.js");
  const { getOrderForUpdate, listOrderItems: listItems, updateOrderStatus } = await import("../../src/modules/orders/repository.js");

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        const loaded = await getOrderForUpdate(orgA, order.id, tx);
        const items = await listItems(orgA, order.id, tx);
        for (const item of items) {
          await createMovement(orgA, actor, "req-2", item.productId, { type: "ADJUSTMENT_OUT", quantity: item.quantity, reason: `Order ${order.id} confirmed` }, tx);
        }
        await updateOrderStatus(orgA, order.id, "CONFIRMED", tx);
        void loaded;
        await recordAuditEvent(
          {
            organizationId: orgA.organizationId,
            actorType: "user",
            actorId: "test-actor",
            // @ts-expect-error deliberately violating the NOT NULL constraint to prove rollback
            action: null,
            resourceType: "order",
            resourceId: order.id,
          },
          tx,
        );
      }),
    /audit_events/i,
  );

  const reloaded = await getOrderOrThrow(orgA, order.id);
  assert.equal(reloaded.status, "DRAFT", "status change must not persist after rollback");
  const balance = await getBalance(orgA, product.id);
  assert.equal(balance?.quantity, "10.000000", "stock decrease must not persist after rollback");
});

test("20a: an archived Product cannot be added to a new DRAFT Order", async () => {
  const product = await pricedProduct(orgA, "Produto Arquivado", "10.00");
  await updateProduct(orgA, product.id, { status: "ARCHIVED" });
  await assert.rejects(() => createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "1" }] }), ProductArchivedError);
});

test("20b: a Product archived AFTER being added to a DRAFT fails confirmation with a deterministic error, Order stays DRAFT", async () => {
  const product = await pricedProduct(orgA, "Produto Arquivado Tardio", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "2" }] });
  await updateProduct(orgA, product.id, { status: "ARCHIVED" });

  await assert.rejects(() => confirmOrder(orgA, actor, "req-2", order.id), ProductArchivedError);
  const reloaded = await getOrderOrThrow(orgA, order.id);
  assert.equal(reloaded.status, "DRAFT");
  const balance = await getBalance(orgA, product.id);
  assert.equal(balance?.quantity, "10.000000");
});

test("21: an archived Customer cannot be assigned to a new Order, but a historical Order referencing one (archived later) remains valid", async () => {
  const customer = await insertCustomer(orgA, { name: "Cliente a Arquivar" });
  const order = await createOrder(orgA, actor, "req-1", { customerId: customer.id, items: [] });

  await updateCustomer(orgA, customer.id, { status: "ARCHIVED" });

  const reloaded = await getOrderOrThrow(orgA, order.id);
  assert.equal(reloaded.customerId, customer.id, "the historical Order keeps its customer reference after archive");

  await assert.rejects(() => createOrder(orgA, actor, "req-2", { customerId: customer.id, items: [] }), CustomerArchivedError);
});

test("22: invalid lifecycle transitions are rejected — confirming/completing/canceling from the wrong state", async () => {
  const product = await pricedProduct(orgA, "Produto Transicoes", "10.00");
  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "1" }] });

  // Cannot complete a DRAFT order (must be confirmed first).
  await assert.rejects(() => completeOrder(orgA, actor, "req-2", order.id), InvalidOrderStateError);

  // Empty order cannot be confirmed.
  const emptyOrder = await createOrder(orgA, actor, "req-3", { items: [] });
  await assert.rejects(() => confirmOrder(orgA, actor, "req-4", emptyOrder.id), EmptyOrderError);

  await cancelOrder(orgA, actor, "req-5", order.id);
  // Cannot confirm a CANCELED order.
  await assert.rejects(() => confirmOrder(orgA, actor, "req-6", order.id), InvalidOrderStateError);
  // Cannot cancel an already-CANCELED order.
  await assert.rejects(() => cancelOrder(orgA, actor, "req-7", order.id), InvalidOrderStateError);
});

test("23: terminal Orders (COMPLETED/CANCELED) are immutable — no item/customer edits accepted", async () => {
  const product = await pricedProduct(orgA, "Produto Terminal", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const order = await createOrder(orgA, actor, "req-1", { items: [{ productId: product.id, quantity: "1" }] });
  await confirmOrder(orgA, actor, "req-2", order.id);
  await completeOrder(orgA, actor, "req-3", order.id);

  await assert.rejects(() => addOrderItem(orgA, actor, "req-4", order.id, { productId: product.id, quantity: "1" }), InvalidOrderStateError);
  await assert.rejects(() => updateOrderCustomerOrThrow(orgA, actor, "req-5", order.id, null), InvalidOrderStateError);

  const canceledOrder = await createOrder(orgA, actor, "req-6", { items: [] });
  await cancelOrder(orgA, actor, "req-7", canceledOrder.id);
  await assert.rejects(() => addOrderItem(orgA, actor, "req-8", canceledOrder.id, { productId: product.id, quantity: "1" }), InvalidOrderStateError);
});

test("product price missing: a Product with no price cannot be added to an Order (NULL is never silently treated as zero)", async () => {
  const unpriced = await insertProduct(orgA, { name: "Produto Sem Preço" });
  await assert.rejects(() => createOrder(orgA, actor, "req-1", { items: [{ productId: unpriced.id, quantity: "1" }] }), ProductPriceRequiredError);
});

test("listAllOrders is tenant-scoped and supports the status filter", async () => {
  const org = { organizationId: randomUUID() };
  const product = await pricedProduct(org, "Produto Lista", "5.00");
  const draft = await createOrder(org, actor, "req-1", { items: [{ productId: product.id, quantity: "1" }] });
  const another = await createOrder(org, actor, "req-2", { items: [] });
  await cancelOrder(org, actor, "req-3", another.id);

  const draftOnly = await listAllOrders(org, { status: "DRAFT", limit: 50 });
  assert.ok(draftOnly.some((o) => o.id === draft.id));
  assert.ok(!draftOnly.some((o) => o.id === another.id));

  const allOrders = await listAllOrders(org, { limit: 50 });
  assert.equal(allOrders.length, 2);

  const fromOtherOrg = await listAllOrders(orgB, { limit: 50 });
  assert.ok(!fromOtherOrg.some((o) => o.id === draft.id));
});

/**
 * F23 brief §42 — MANDATORY concurrency proof. Stock = 10. Order A and
 * Order B each request 7. Confirm both concurrently (real, independently
 * opened `db.transaction`s racing on the real Postgres connection pool).
 * Expected: exactly one Order becomes CONFIRMED, the other fails/stays
 * DRAFT, final stock = 3, exactly one ADJUSTMENT_OUT movement — reusing
 * F22's own proven atomic conditional UPDATE unchanged (ADR-028), not a
 * new concurrency mechanism.
 */
test("CONCURRENCY: two Orders concurrently confirming for the same product (7+7 against a stock of 10) — exactly one CONFIRMED, stock = 3, one movement", async () => {
  const org = { organizationId: randomUUID() };
  const product = await pricedProduct(org, "Produto Concorrência", "10.00");
  const { createMovement } = await import("../../src/modules/inventory/service.js");
  await createMovement(org, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const orderA = await createOrder(org, actor, "req-a-create", { items: [{ productId: product.id, quantity: "7" }] });
  const orderB = await createOrder(org, actor, "req-b-create", { items: [{ productId: product.id, quantity: "7" }] });

  const results = await Promise.allSettled([confirmOrder(org, actor, "req-a-confirm", orderA.id), confirmOrder(org, actor, "req-b-confirm", orderB.id)]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one confirmation must succeed");
  assert.equal(rejected.length, 1, "exactly one confirmation must fail");
  assert.ok((rejected[0] as PromiseRejectedResult).reason instanceof InsufficientStockError);

  const reloadedA = await getOrderOrThrow(org, orderA.id);
  const reloadedB = await getOrderOrThrow(org, orderB.id);
  const statuses = [reloadedA.status, reloadedB.status].sort();
  assert.deepEqual(statuses, ["CONFIRMED", "DRAFT"], "one Order confirmed, the other never left DRAFT — never both CONFIRMED");

  const balance = await getBalance(org, product.id);
  assert.equal(balance?.quantity, "3.000000", "10 - 7 = 3, never negative, never double-applied");

  const movements = await listMovements(org, product.id, { limit: 10 });
  assert.equal(movements.filter((m) => m.type === "ADJUSTMENT_OUT").length, 1, "exactly one movement — the loser never inserted one");
});
