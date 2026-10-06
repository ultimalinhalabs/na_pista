import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, createProduct, loadF22Fixtures, registerF22Credentials, startApp } from "./inventoryHelpers.js";

/** F22 brief §31 E2E — the core RECEIPT/ADJUSTMENT_IN/ADJUSTMENT_OUT lifecycle, over real HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF22Fixtures();

before(async () => {
  ctx = await startApp();
  registerF22Credentials(fixtures);
});
after(async () => {
  await ctx.close();
  // Bounded: an untimed end() can take 70-90s on the remote pooler and blow the file's 90s budget (F30 report §15).
  await queryClient.end({ timeout: 5 });
});

test("RECEIPT creates the balance, ADJUSTMENT_IN/OUT change it, GET reflects the current state, movements list the full history", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E Azul");

  const notFoundYet = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(notFoundYet.status, 404);
  assert.equal(notFoundYet.error.code, "INVENTORY_NOT_FOUND");

  const receipt = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 20, reason: "Initial stock" },
  });
  assert.equal(receipt.status, 201);
  assert.equal(receipt.data.balance.quantity, "20.000000");
  assert.equal(receipt.data.movement.type, "RECEIPT");

  const adjustIn = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "ADJUSTMENT_IN", quantity: 5 },
  });
  assert.equal(adjustIn.status, 201);
  assert.equal(adjustIn.data.balance.quantity, "25.000000");

  const adjustOut = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "ADJUSTMENT_OUT", quantity: 8, reason: "Damaged stock" },
  });
  assert.equal(adjustOut.status, 201);
  assert.equal(adjustOut.data.balance.quantity, "17.000000");

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.status, 200);
  assert.equal(balance.data.quantity, "17.000000");
  assert.equal(balance.data.productName, "Camisola E2E Azul");
  assert.equal(balance.data.productUnit, "UNIT");

  const movements = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, { token: fixtures.orgA.ownerToken });
  assert.equal(movements.status, 200);
  assert.equal(movements.data.length, 3);
  assert.deepEqual(
    movements.data.map((m: { type: string }) => m.type),
    ["ADJUSTMENT_OUT", "ADJUSTMENT_IN", "RECEIPT"], // newest first
  );

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((b: { productId: string }) => b.productId === product.id));
});

test("ADJUSTMENT_OUT beyond available stock returns 409 INSUFFICIENT_STOCK over HTTP, balance unchanged", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E Insuficiente");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 3 },
  });

  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "ADJUSTMENT_OUT", quantity: 10 },
  });
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "INSUFFICIENT_STOCK");

  const balance = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory/${product.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(balance.data.quantity, "3.000000");
});

test("there is no PATCH for a direct quantity overwrite — quantity only changes through a movement (F22 brief §15)", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E No Patch");
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/inventory/${product.id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ quantity: 999 }),
  });
  assert.equal(res.status, 404); // no route registered for PATCH on this path
});

test("invalid movement bodies are rejected: zero/negative quantity, unknown type, protected fields", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E Validacao");

  const zero = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 0 },
  });
  assert.equal(zero.status, 400);
  assert.equal(zero.error.code, "VALIDATION_ERROR");

  const badType = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "SALE", quantity: 1 },
  });
  assert.equal(badType.status, 400);

  const protectedField = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 1, organizationId: "22222222-2222-2222-2222-222222222222" },
  });
  assert.equal(protectedField.status, 400);
});

test("request reference (X-Request-ID) is preserved on an inventory write", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E RequestId");
  const suppliedId = "f22-e2e-probe-789";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": suppliedId },
    body: JSON.stringify({ type: "RECEIPT", quantity: 1 }),
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);
});

test("a real movement produces exactly one inventory.receipt-shaped audit_events row, atomically, with a requestId", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Camisola E2E Audit");
  const requestId = `f22-audit-probe-${Date.now()}`;
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ type: "RECEIPT", quantity: 4 }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, body.data.movement.id)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, "inventory.receipt");
  assert.equal(rows[0]!.resourceType, "inventory_movement");
  assert.equal(rows[0]!.actorType, "user");
  assert.equal(rows[0]!.actorId, fixtures.orgA.ownerId);
  assert.equal(rows[0]!.requestId, requestId);
});
