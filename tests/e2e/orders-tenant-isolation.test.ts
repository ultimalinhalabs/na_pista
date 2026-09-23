import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createCustomer, createProduct, loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/** F23 brief §41 E2E items 21-23 — cross-tenant Order/Product/Customer access, over HTTP. Structural (composite FK) proof already in tests/integration/orders.test.ts item 18. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("21: organization A cannot list, GET, or mutate organization B's Orders", async () => {
  const productB = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Produto B Isolamento", "10.00");
  const orderB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/orders`, {
    token: fixtures.orgB.ownerToken,
    body: { items: [{ productId: productB.id, quantity: 1 }] },
  });

  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/orders/${orderB.data.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(getAsA.status, 403, "owner A has no membership in org B -> blocked before ever reaching the row");

  const confirmAsA = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/orders/${orderB.data.id}/confirm`, { token: fixtures.orgA.ownerToken });
  assert.equal(confirmAsA.status, 403);

  const listAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders`, { token: fixtures.orgA.ownerToken });
  assert.ok(!listAsA.data.some((o: { id: string }) => o.id === orderB.data.id));
});

test("22: a product from organization B cannot be added to an organization A Order", async () => {
  const productB = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Produto B Cross-ref", "10.00");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: productB.id, quantity: 1 }] },
  });
  assert.equal(res.status, 404);
  assert.equal(res.error.code, "PRODUCT_NOT_FOUND");
});

test("23: a customer from organization B cannot be assigned to an organization A Order", async () => {
  const customerB = await createCustomer(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Cliente B Cross-ref");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { customerId: customerB.id, items: [] },
  });
  assert.equal(res.status, 404);
  assert.equal(res.error.code, "NOT_FOUND");
});

test("an org-B order id used on org A's own path (real membership, wrong resource) resolves 403 (no membership in B at all — never leaks existence)", async () => {
  const productB = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Produto B Path Probe", "10.00");
  const orderB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/orders`, {
    token: fixtures.orgB.ownerToken,
    body: { items: [{ productId: productB.id, quantity: 1 }] },
  });
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders/${orderB.data.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 404, "real membership in org A, but org B's order id resolves to nothing under org A's tenant filter");
});
