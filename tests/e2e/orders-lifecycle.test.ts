import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createCustomer, createProduct, loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/** F23 brief §41 E2E items 1-4, 8-13, 34. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("1/4/9/13: OWNER creates an Order with items — server derives productName/unitPrice, computes subtotal/total, currency is AOA", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E", 5000);
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 2 }] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgA.id);
  assert.equal(res.data.status, "DRAFT");
  assert.equal(res.data.currency, "AOA");
  assert.equal(res.data.items.length, 1);
  assert.equal(res.data.items[0].productName, "Camisola E2E");
  assert.equal(res.data.items[0].unitPrice, "5000.00");
  assert.equal(res.data.items[0].subtotal, "10000.00");
  assert.equal(res.data.subtotal, "10000.00");
  assert.equal(res.data.total, "10000.00");
});

test("2: an Order can be created WITH a Customer", async () => {
  const customer = await createCustomer(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Cliente E2E");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { customerId: customer.id, items: [] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.customerId, customer.id);
});

test("3: an Order can be created WITHOUT a Customer (anonymous/walk-in, F18 OD-03 closed by F23A)", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [] },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.customerId, null);
});

test("8: DRAFT editing — add item, change quantity, remove item, recalculate totals; then GET reflects it", async () => {
  const p1 = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Editar 1", "10.00");
  const p2 = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Editar 2", "20.00");

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, { token: fixtures.orgA.ownerToken, body: { items: [] } });
  const orderId = created.data.id;

  const added = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/items`, {
    token: fixtures.orgA.ownerToken,
    body: { productId: p1.id, quantity: 3 },
  });
  assert.equal(added.status, 201);
  assert.equal(added.data.total, "30.00");
  const itemId = added.data.items[0].id;

  const added2 = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/items`, {
    token: fixtures.orgA.ownerToken,
    body: { productId: p2.id, quantity: 1 },
  });
  assert.equal(added2.data.total, "50.00");

  const updated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/orders/${orderId}/items/${itemId}`, {
    token: fixtures.orgA.ownerToken,
    body: { quantity: 5 },
  });
  assert.equal(updated.data.total, "70.00"); // 10*5 + 20*1

  const removed = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/orders/${orderId}/items/${itemId}`, { token: fixtures.orgA.ownerToken });
  assert.equal(removed.data.items.length, 1);
  assert.equal(removed.data.total, "20.00");

  const get = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders/${orderId}`, { token: fixtures.orgA.ownerToken });
  assert.equal(get.data.total, "20.00", "GET reflects the recalculated total — never stale");
});

test("10/11/12: full lifecycle DRAFT -> CONFIRMED -> COMPLETED, each transition visible via GET", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Ciclo", "100.00");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 10 },
  });

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 2 }] },
  });
  const orderId = created.data.id;

  const confirmed = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/confirm`, { token: fixtures.orgA.ownerToken });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.status, "CONFIRMED");

  const completed = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/complete`, { token: fixtures.orgA.ownerToken });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.status, "COMPLETED");

  const get = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders/${orderId}`, { token: fixtures.orgA.ownerToken });
  assert.equal(get.data.status, "COMPLETED");
});

test("list: GET /orders supports status filtering, tenant-scoped", async () => {
  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders?status=DRAFT`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data));
  assert.ok(list.data.every((o: { status: string }) => o.status === "DRAFT"));
});

test("34: request reference (X-Request-ID) is preserved on an Order write", async () => {
  const suppliedId = "f23-e2e-probe-321";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": suppliedId },
    body: JSON.stringify({ items: [] }),
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);
});
