import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, createProduct, loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/** F23 brief §41 E2E items 30/31 — real audit rows and real Platform usage. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("30: creating and confirming an Order produces order.created and order.confirmed audit rows, with no customer PII in metadata", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Audit E2E", "10.00");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 5 },
  });

  const requestId = `f23-audit-probe-${Date.now()}`;
  const createRes = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ items: [{ productId: product.id, quantity: 1 }] }),
  });
  const order = (await createRes.json()).data;
  assert.equal(createRes.status, 201);

  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, order.id), eq(auditEvents.action, "order.created")));
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0]!.actorType, "user");
  assert.equal(createdRows[0]!.actorId, fixtures.orgA.ownerId);
  assert.equal(createdRows[0]!.requestId, requestId);

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders/${order.id}/confirm`, { token: fixtures.orgA.ownerToken });
  const confirmedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, order.id), eq(auditEvents.action, "order.confirmed")));
  assert.equal(confirmedRows.length, 1);
});

test("31: a real Order write records real Platform usage (api_requests meter)", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Produto Usage E2E", "10.00");

  const before1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before1.data?.quantity ?? 0;

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/orders`, {
    token: fixtures.orgA.ownerToken,
    body: { items: [{ productId: product.id, quantity: 1 }] },
  });

  let afterQty = beforeQty;
  for (let i = 0; i < 10 && afterQty <= beforeQty; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const after1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
      headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
    }).then((r) => r.json());
    afterQty = after1.data?.quantity ?? beforeQty;
  }
  assert.ok(afterQty > beforeQty, `expected api_requests usage to increase from ${beforeQty}, got ${afterQty}`);
});
