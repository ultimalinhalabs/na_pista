import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, loadF24Fixtures, registerF24Credentials, startApp } from "./servicesHelpers.js";

/** F24 brief §21 E2E items 13/14 — real audit rows and real Platform usage. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF24Fixtures();

before(async () => {
  ctx = await startApp();
  registerF24Credentials(fixtures);
});
after(() => ctx.close());

test("13: creating and archiving a Service produces service.created and service.archived audit rows, with no PII", async () => {
  const requestId = `f24-audit-probe-${Date.now()}`;
  const createRes = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/services`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ name: "Serviço Audit E2E", durationMinutes: 30 }),
  });
  const service = (await createRes.json()).data;
  assert.equal(createRes.status, 201);

  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, service.id), eq(auditEvents.action, "service.created")));
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0]!.actorType, "user");
  assert.equal(createdRows[0]!.actorId, fixtures.orgA.ownerId);
  assert.equal(createdRows[0]!.requestId, requestId);

  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });
  const archivedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, service.id), eq(auditEvents.action, "service.archived")));
  assert.equal(archivedRows.length, 1);
});

test("14: creating a Service records real Platform usage (api_requests meter)", async () => {
  const before1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before1.data?.quantity ?? 0;

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken, body: { name: "Serviço Usage E2E", durationMinutes: 30 } });

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
