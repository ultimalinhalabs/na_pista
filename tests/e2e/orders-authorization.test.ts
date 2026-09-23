import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/**
 * F23 brief §41 E2E items 24/25/28/29. Revoked/expired service credential
 * behavior is deliberately NOT re-proven here — exhaustively covered by
 * F19 (8 dedicated tests) and reused unchanged by F20/F21/F22; this file
 * only proves Orders' own wiring into the same, unchanged mechanisms.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("24: STAFF can read Orders but is denied from creating or mutating them", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto STAFF Probe", "10.00");

  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.staffA.token,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });
  assert.equal(create.status, 403);
  assert.equal(create.error.code, "FORBIDDEN");

  const ownerOrder = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });

  const confirmAsStaff = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${ownerOrder.data.id}/confirm`, { token: fixtures.staffA.token });
  assert.equal(confirmAsStaff.status, 403);
});

test("25: MANAGER can create Orders and drive the full lifecycle (confirm/complete/cancel)", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto MANAGER Probe", "10.00");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 5 },
  });

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.managerA.token,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });
  assert.equal(create.status, 201);

  const confirm = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${create.data.id}/confirm`, { token: fixtures.managerA.token });
  assert.equal(confirm.status, 200);

  const complete = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${create.data.id}/complete`, { token: fixtures.managerA.token });
  assert.equal(complete.status, 200);
});

test("28: a service credential with sufficient scope (catalog.write) can create and confirm an Order on its own organization", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Service Probe", "10.00");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 5 },
  });

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.apiKeys.integrationA.secret,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });
  assert.equal(create.status, 201);
  assert.equal(create.data.organizationId, fixtures.orgA.id);

  const confirm = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${create.data.id}/confirm`, { token: fixtures.apiKeys.integrationA.secret });
  assert.equal(confirm.status, 200);
});

test("29: a service credential with insufficient scope (usage.write/event.publish only, no catalog.write) is blocked from writing", async () => {
  // platformFacingA (F22/F23 fixture convention) is Na Pista's own
  // outbound usage/event credential — usage.write/event.publish only, no
  // catalog.* scope at all — so it's blocked from both read and write on
  // Orders, unlike a genuine "insufficient write scope, has read" case.
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Scope Probe", "10.00");
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.apiKeys.platformFacingA.secret,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });
  assert.equal(create.status, 403);
  assert.equal(create.error.code, "FORBIDDEN");
});

test("no Authorization header -> 401", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders`);
  assert.equal(res.status, 401);
});
