import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF22Fixtures, registerF22Credentials, startApp } from "./inventoryHelpers.js";

/** F22 brief §22/§31 E2E — an archived product's inventory stays fully readable, but never receives a new movement. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF22Fixtures();

before(async () => {
  ctx = await startApp();
  registerF22Credentials(fixtures);
});
after(() => ctx.close());

test("archiving a product blocks new inventory movements but keeps its balance/history readable", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola A Descontinuar");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 12 },
  });

  const archive = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/products/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(archive.status, 200);
  assert.equal(archive.data.status, "ARCHIVED");

  const blockedReceipt = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "ADJUSTMENT_IN", quantity: 1 },
  });
  assert.equal(blockedReceipt.status, 409);
  assert.equal(blockedReceipt.error.code, "PRODUCT_ARCHIVED");

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.status, 200);
  assert.equal(balance.data.quantity, "12.000000", "the archived product's balance remains exactly as it was, still readable");
  assert.equal(balance.data.productStatus, "ARCHIVED");

  const movements = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, { token: fixtures.orgA.ownerToken });
  assert.equal(movements.status, 200);
  assert.equal(movements.data.length, 1, "history is preserved; the blocked attempt inserted nothing");

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory`, { token: fixtures.orgA.ownerToken });
  assert.ok(list.data.some((b: { productId: string }) => b.productId === product.id), "archived-product balances still appear in the tenant's inventory list");
});
