import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { eq, and } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/** F20 brief §19/§20/§28 scenarios 12-13: audit and usage are real, not faked. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fixtures);
});
after(async () => {
  await ctx.close();
  // Bounded: an untimed end() can take 70-90s on the remote pooler and blow the file's 90s budget (F30 report §15).
  await queryClient.end({ timeout: 5 });
});

test("product.created produces a real audit_events row in Na Pista's own database", async () => {
  const requestId = `f20-audit-probe-${Date.now()}`;
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ name: "F20 Audit Probe" }),
  });
  const body = await res.json();
  assert.equal(res.status, 201);

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, body.data.id)));

  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, "product.created");
  assert.equal(rows[0]!.actorType, "user");
  assert.equal(rows[0]!.actorId, fixtures.orgA.ownerId);
  assert.equal(rows[0]!.requestId, requestId);
  assert.equal(rows[0]!.resourceType, "product");
});

test("category.deleted (archive) produces its own audit action, distinct from category.updated", async () => {
  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/categories`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "F20 Audit Archive Probe" },
  });
  await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/categories/${created.data.id}`, { token: fixtures.orgA.ownerToken });

  const { categories } = await import("../../src/db/schema/index.js");
  void categories; // referenced only for clarity of what resourceType below corresponds to

  const rows = await db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, created.data.id)));

  assert.deepEqual(
    rows.map((r) => r.action).sort(),
    ["category.created", "category.deleted"],
  );
});

test("a product write records real Platform usage (api_requests meter) — no fake/local-only usage", async () => {
  const before = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before.data?.quantity ?? 0;

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "F20 Usage Probe" },
  });

  // Usage is written fire-and-forget (ADR-023: never blocks the response,
  // never breaks the operation on failure) — poll briefly for it to land
  // rather than assuming it is synchronous with the HTTP response.
  let afterQty = beforeQty;
  for (let i = 0; i < 10 && afterQty <= beforeQty; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const after = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
      headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
    }).then((r) => r.json());
    afterQty = after.data?.quantity ?? beforeQty;
  }
  assert.ok(afterQty > beforeQty, `expected api_requests usage to increase from ${beforeQty}, got ${afterQty}`);
});
