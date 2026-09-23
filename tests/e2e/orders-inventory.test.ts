import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF23Fixtures, receiveStock, registerF23Credentials, startApp } from "./ordersHelpers.js";

/** F23 brief §41 E2E items 14-19 — the Order/Inventory boundary (ADR-032), over real HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("14: a DRAFT Order does not change Inventory", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto DRAFT Stock", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 10);

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 4 }] },
  });

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.data.quantity, "10.000000", "creating a DRAFT order must not touch the balance");
});

test("15/18: CONFIRM changes Inventory and creates a real StockMovement", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Confirm Stock", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 10);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 4 }] },
  });
  const orderId = created.data.id;

  const confirmed = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/confirm`, { token: fixtures.orgA.ownerToken });
  assert.equal(confirmed.status, 200);

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.data.quantity, "6.000000");

  const movements = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, { token: fixtures.orgA.ownerToken });
  assert.ok(movements.data.some((m: { type: string; quantity: string; reason: string | null }) => m.type === "ADJUSTMENT_OUT" && m.quantity === "4.000000" && m.reason?.includes(orderId)));
});

test("16/17: insufficient stock blocks confirmation with a domain error, and the failed confirmation leaves the Order DRAFT", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Stock Insuficiente", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 2);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 9 }] },
  });
  const orderId = created.data.id;

  const confirmAttempt = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/confirm`, { token: fixtures.orgA.ownerToken });
  assert.equal(confirmAttempt.status, 409);
  assert.equal(confirmAttempt.error.code, "INSUFFICIENT_STOCK");
  // The raw database error is never exposed — a clean domain error only.
  assert.ok(!JSON.stringify(confirmAttempt.error).match(/postgres|constraint|relation/i));

  const get = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders/${orderId}`, { token: fixtures.orgA.ownerToken });
  assert.equal(get.data.status, "DRAFT", "a failed confirmation never partially confirms — Order stays DRAFT");

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.data.quantity, "2.000000", "balance untouched by a failed confirmation");
});

test("19: COMPLETE does not consume stock a second time", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Complete Stock", "10.00");
  await receiveStock(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, product.id, 10);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 3 }] },
  });
  const orderId = created.data.id;
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/confirm`, { token: fixtures.orgA.ownerToken });

  const balanceBeforeComplete = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });

  const completed = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${orderId}/complete`, { token: fixtures.orgA.ownerToken });
  assert.equal(completed.status, 200);

  const balanceAfterComplete = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balanceAfterComplete.data.quantity, balanceBeforeComplete.data.quantity, "completion must never change the balance again");
});
