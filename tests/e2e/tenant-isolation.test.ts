import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/** F20 brief §11/§28 scenarios 6 and 9, and §15's category/product relation rule. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("organization A cannot list, read, update or delete organization B's products", async () => {
  const productB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/products`, {
    token: fixtures.orgB.ownerToken,
    body: { name: "Product B (isolation target)" },
  });
  assert.equal(productB.status, 201);

  const listAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.orgA.ownerToken });
  assert.ok(!listAsA.data.some((p: any) => p.id === productB.data.id));

  // Owner A has no membership in org B at all -> blocked before ever reaching the row.
  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/products/${productB.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(getAsA.status, 403);

  const patchAsA = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgB.id}/products/${productB.data.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "hacked" },
  });
  assert.equal(patchAsA.status, 403);

  const deleteAsA = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgB.id}/products/${productB.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(deleteAsA.status, 403);
});

test("an org-B id used on org A's own path (both real memberships, wrong resource) resolves 404, never the row", async () => {
  const productB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/products`, {
    token: fixtures.orgB.ownerToken,
    body: { name: "Product B (cross-id probe)" },
  });
  // Owner A DOES have membership in org A — this reaches the repository,
  // which must not find org B's row under org A's tenant filter.
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products/${productB.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(res.status, 404);
});

test("a category from organization B can never be assigned to a product in organization A", async () => {
  const categoryB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/categories`, {
    token: fixtures.orgB.ownerToken,
    body: { name: "Category B (cross-tenant probe)" },
  });
  assert.equal(categoryB.status, 201);

  const createRes = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Should be rejected", categoryId: categoryB.data.id },
  });
  assert.equal(createRes.status, 400);
  assert.equal(createRes.error.code, "VALIDATION_ERROR");

  // Same rule on update: create a valid product in A first, then try to
  // re-point it at org B's category.
  const productA = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Valid product A" },
  });
  const updateRes = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/products/${productA.data.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { categoryId: categoryB.data.id },
  });
  assert.equal(updateRes.status, 400);
});
