import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/** F23 brief §41 E2E items 5-7 — the core "server derives price, client can never inject it" guarantee (ADR-031, F23 brief §13/§14). */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("5: a Product without a price is rejected from an Order with a deterministic error, never silently treated as free", async () => {
  const unpriced = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Sem Preço E2E");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: unpriced.id, quantity: 1 }] },
  });
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "PRODUCT_PRICE_REQUIRED");
});

test("6: a client cannot manipulate unitPrice — a submitted unitPrice is rejected by strict validation, never trusted", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Preço Real", "10000.00");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 1, unitPrice: "0.01" }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, "VALIDATION_ERROR");
});

test("7: a client cannot manipulate the order total — a submitted total/subtotal/currency is rejected by strict validation", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Total Real", "10000.00");
  for (const field of ["total", "subtotal", "currency"]) {
    const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
      token: fixtures.orgA.ownerToken,
      body: { items: [{ productId: product.id, quantity: 1 }], [field]: "0.01" },
    });
    assert.equal(res.status, 400, `expected ${field} to be rejected`);
    assert.equal(res.error.code, "VALIDATION_ERROR");
  }

  // Even when accepted, the server-computed total is exactly quantity * price — never influenced by anything the client sent.
  const accepted = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 3 }] },
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.total, "30000.00");
});

test("productName cannot be manipulated by the client — always the real Product's current name", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Nome Real do Produto", "1.00");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 1, productName: "Nome Falso" }] },
  });
  assert.equal(res.status, 400, "productName is not even a valid item field");
});
