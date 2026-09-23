import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF23Fixtures, receiveStock, registerF23Credentials, startApp } from "./ordersHelpers.js";

/** F23 brief §41 E2E item 20 — cancellation follows F23A/ADR-032 exactly: DRAFT->CANCELED touches nothing, CONFIRMED->CANCELED reverses via the existing ADJUSTMENT_IN. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("cancelling a DRAFT Order never touches Inventory", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Cancel DRAFT", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 5);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 2 }] },
  });

  const canceled = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${created.data.id}/cancel`, { token: fixtures.orgA.ownerToken });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.status, "CANCELED");

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.data.quantity, "5.000000");
});

test("cancelling a CONFIRMED Order reverses exactly the stock it consumed", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Cancel CONFIRMED", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 10);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 6 }] },
  });
  const orderId = created.data.id;
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/confirm`, { token: fixtures.orgA.ownerToken });

  const balanceAfterConfirm = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balanceAfterConfirm.data.quantity, "4.000000");

  const canceled = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/cancel`, { token: fixtures.orgA.ownerToken });
  assert.equal(canceled.status, 200);
  assert.equal(canceled.data.status, "CANCELED");

  const balanceAfterCancel = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balanceAfterCancel.data.quantity, "10.000000");
});

test("a COMPLETED Order cannot be canceled", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Cancel Completed", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 10);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });
  const orderId = created.data.id;
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/confirm`, { token: fixtures.orgA.ownerToken });
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/complete`, { token: fixtures.orgA.ownerToken });

  const cancelAttempt = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/cancel`, { token: fixtures.orgA.ownerToken });
  assert.equal(cancelAttempt.status, 409);
  assert.equal(cancelAttempt.error.code, "INVALID_ORDER_STATE");
});
