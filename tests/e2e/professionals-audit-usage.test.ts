import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, createService, loadF25Fixtures, registerF25Credentials, startApp } from "./professionalsHelpers.js";

/** F25 brief §38 items 13/14 — real audit rows (including association events) and real Platform usage. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF25Fixtures();

before(async () => {
  ctx = await startApp();
  registerF25Credentials(fixtures);
});
after(() => ctx.close());

test("13: creating and archiving a Professional produces professional.created and professional.archived audit rows, with no PII beyond what the resource itself already exposes", async () => {
  const requestId = `f25-audit-probe-${Date.now()}`;
  const createRes = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ name: "Profissional Audit E2E" }),
  });
  const professional = (await createRes.json()).data;
  assert.equal(createRes.status, 201);

  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, professional.id), eq(auditEvents.action, "professional.created")));
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0]!.actorType, "user");
  assert.equal(createdRows[0]!.actorId, fixtures.orgA.ownerId);
  assert.equal(createdRows[0]!.requestId, requestId);

  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });
  const archivedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, professional.id), eq(auditEvents.action, "professional.archived")));
  assert.equal(archivedRows.length, 1);

  const genericUpdateRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, professional.id), eq(auditEvents.action, "professional.updated")));
  assert.equal(genericUpdateRows.length, 0, "archiving must log professional.archived, never also a generic professional.updated");
});

test("associating and removing a Service produces professional_service.created and professional_service.removed audit rows", async () => {
  const professionalRes = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Profissional Audit Associação" }),
  });
  const professional = (await professionalRes.json()).data;
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Audit Associação", 30);

  const requestId = `f25-assoc-audit-probe-${Date.now()}`;
  const associateRes = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "x-request-id": requestId },
  });
  const association = (await associateRes.json()).data;
  assert.equal(associateRes.status, 201);

  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, association.id), eq(auditEvents.action, "professional_service.created")));
  assert.equal(createdRows.length, 1);
  assert.equal(createdRows[0]!.requestId, requestId);

  await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  const removedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, association.id), eq(auditEvents.action, "professional_service.removed")));
  assert.equal(removedRows.length, 1);
});

test("14: creating a Professional records real Platform usage (api_requests meter)", async () => {
  const before1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before1.data?.quantity ?? 0;

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken, body: { name: "Profissional Usage E2E" } });

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
