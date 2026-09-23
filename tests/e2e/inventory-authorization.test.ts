import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF22Fixtures, registerF22Credentials, startApp } from "./inventoryHelpers.js";

/**
 * F22 brief §31 E2E — authorization matrix. Revoked/expired service
 * credential behavior is deliberately NOT re-proven here — that
 * mechanism (Platform introspection via GET /v1/service/me) is
 * exhaustively covered by F19 (8 dedicated tests) and reused unchanged
 * by F20/F21; this file only proves Inventory's OWN wiring into it,
 * plus the custom inline permission split (RECEIPT=inventory.create vs
 * ADJUSTMENT=inventory.update) that routes.ts implements (F22 brief §19).
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF22Fixtures();

before(async () => {
  ctx = await startApp();
  registerF22Credentials(fixtures);
});
after(() => ctx.close());

test("STAFF can read inventory but is denied from recording any movement (RECEIPT or ADJUSTMENT)", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "STAFF Read Probe");

  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const receipt = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.staffA.token,
    body: { type: "RECEIPT", quantity: 5 },
  });
  assert.equal(receipt.status, 403);
  assert.equal(receipt.error.code, "FORBIDDEN");

  // Give the product a balance via OWNER so the ADJUSTMENT_IN attempt below has something to act on.
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 5 },
  });
  const adjust = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.staffA.token,
    body: { type: "ADJUSTMENT_IN", quantity: 1 },
  });
  assert.equal(adjust.status, 403);
});

test("MANAGER can RECEIPT (inventory.create) and ADJUSTMENT (inventory.update) — both gated permissions are granted", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "MANAGER Full Probe");

  const receipt = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.managerA.token,
    body: { type: "RECEIPT", quantity: 10 },
  });
  assert.equal(receipt.status, 201);

  const adjustOut = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.managerA.token,
    body: { type: "ADJUSTMENT_OUT", quantity: 2 },
  });
  assert.equal(adjustOut.status, 201);
});

test("a service credential with sufficient scope (catalog.write) can record a movement on its own organization", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Service Credential Probe");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.apiKeys.integrationA.secret,
    body: { type: "RECEIPT", quantity: 6 },
  });
  assert.equal(res.status, 201);
});

test("a service credential with insufficient scope (usage.write/event.publish only, no catalog.write) is blocked from writing", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Service Scope Probe");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.apiKeys.platformFacingA.secret,
    body: { type: "RECEIPT", quantity: 1 },
  });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, "FORBIDDEN");
});

test("no Authorization header -> 401", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory`);
  assert.equal(res.status, 401);
});
