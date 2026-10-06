import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { eq, and } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, loadF21Fixtures, registerF21Credentials, startApp } from "./customersHelpers.js";

/** F21 brief §19 E2E matrix items 1-4, 13-16, 25. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF21Fixtures();

before(async () => {
  ctx = await startApp();
  registerF21Credentials(fixtures);
});
after(async () => {
  await ctx.close();
  // Bounded: an untimed end() can take 70-90s on the remote pooler and blow the file's 90s budget (F30 report §15).
  await queryClient.end({ timeout: 5 });
});

test("OWNER creates, reads, updates and archives a customer", async () => {
  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Ana Silva", email: "ana.silva@example.com", phone: "+244923456789", notes: "Cliente desde 2024" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.organizationId, fixtures.orgA.id);
  assert.equal(created.data.status, "ACTIVE");

  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(read.status, 200);
  assert.equal(read.data.email, "ana.silva@example.com");

  const updated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/customers/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { notes: "Cliente VIP" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.notes, "Cliente VIP");
  assert.equal(updated.data.name, "Ana Silva", "unrelated fields survive a partial PATCH");

  const archived = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/customers/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.status, "ARCHIVED");

  // F21 brief §16/§25: archived, never physically deleted — still readable by id.
  const stillReadable = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(stillReadable.status, 200);
  assert.equal(stillReadable.data.status, "ARCHIVED");

  // Default active list excludes it; explicit ARCHIVED filter includes it.
  const activeList = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers?status=ACTIVE`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.ok(!activeList.data.some((c: any) => c.id === created.data.id));
  const archivedList = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers?status=ARCHIVED`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.ok(archivedList.data.some((c: any) => c.id === created.data.id));
});

test("invalid name is rejected", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, "VALIDATION_ERROR");
});

test("invalid email is rejected", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Test Customer", email: "not-an-email" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, "VALIDATION_ERROR");
});

test("client-supplied id/organizationId/status/createdAt on create are rejected, never silently accepted", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "x", id: "11111111-1111-1111-1111-111111111111", organizationId: "22222222-2222-2222-2222-222222222222", status: "ARCHIVED" },
  });
  assert.equal(res.status, 400);
});

test("request reference (X-Request-ID) is preserved", async () => {
  const suppliedId = "f21-e2e-probe-456";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/customers`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "x-request-id": suppliedId },
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);
});

test("a real create produces exactly one product.created-shaped audit_events row, atomically", async () => {
  const requestId = `f21-audit-probe-${Date.now()}`;
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/customers`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ name: "Audit Probe Customer" }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, body.data.id)));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, "customer.created");
  assert.equal(rows[0]!.actorType, "user");
  assert.equal(rows[0]!.actorId, fixtures.orgA.ownerId);
  assert.equal(rows[0]!.requestId, requestId);
  // F21 brief §18/§13: no PII in audit metadata.
  assert.equal(rows[0]!.metadata, null);
});
