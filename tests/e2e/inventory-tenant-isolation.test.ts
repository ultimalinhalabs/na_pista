import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF22Fixtures, registerF22Credentials, startApp } from "./inventoryHelpers.js";

/**
 * F22 brief §31 E2E — tenant isolation over HTTP. The structural
 * guarantee (composite FK) is already proven at the database layer in
 * tests/integration/inventory.test.ts; this file proves the same
 * invariant is unreachable through the API in the first place.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF22Fixtures();

before(async () => {
  ctx = await startApp();
  registerF22Credentials(fixtures); // registers both org A and org B
});
after(() => ctx.close());

test("organization A cannot see, read, or record movements against organization B's product", async () => {
  const productB = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Product B (isolation target)");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/inventory/${productB.id}/movements`, {
    token: fixtures.orgB.ownerToken,
    body: { type: "RECEIPT", quantity: 5 },
  });

  // Owner A has no membership in org B -> blocked before ever reaching the row.
  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/inventory/${productB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(getAsA.status, 403);

  const movementAsA = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/inventory/${productB.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 1 },
  });
  assert.equal(movementAsA.status, 403);

  const listAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory`, { token: fixtures.orgA.ownerToken });
  assert.ok(!listAsA.data.some((b: { productId: string }) => b.productId === productB.id));
});

test("productId manipulation: an org-B product id used on org A's own path (real membership, wrong resource) resolves 404 PRODUCT_NOT_FOUND, never the row", async () => {
  const productB = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Product B (cross-id probe)");
  // Owner A DOES have membership in org A — this reaches the service,
  // which must not find org B's product under org A's tenant filter.
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${productB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 404);
  assert.equal(res.error.code, "PRODUCT_NOT_FOUND");

  const movement = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${productB.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 1 },
  });
  assert.equal(movement.status, 404);
  assert.equal(movement.error.code, "PRODUCT_NOT_FOUND");
});

test("a service credential scoped to org A cannot operate on org B (cross-tenant credential use)", async () => {
  const productB = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Product B (credential probe)");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/inventory/${productB.id}/movements`, {
    token: fixtures.apiKeys.integrationA.secret,
    body: { type: "RECEIPT", quantity: 1 },
  });
  assert.equal(res.status, 403);
});
