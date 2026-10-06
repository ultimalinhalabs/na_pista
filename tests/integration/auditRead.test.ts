import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { queryClient } from "../../src/db/index.js";
import { AuditEventSchema } from "../../src/contract/schemas.js";
import { listAuditEventsPage, REDACTED } from "../../src/modules/audit/read.js";
import { listAuditEventsQuerySchema } from "../../src/modules/audit/schemas.js";
import { recordAuditEvent } from "../../src/modules/audit/service.js";

/** ADR-055 on real PostgreSQL — the same service and query schema the route uses. */
after(() => queryClient.end());

const newOrg = () => ({ organizationId: randomUUID() });
const page = (org: { organizationId: string }, query: Record<string, string> = {}) =>
  listAuditEventsPage(org, listAuditEventsQuerySchema.parse(query));

async function event(org: { organizationId: string }, overrides: Partial<Parameters<typeof recordAuditEvent>[0]> = {}) {
  await recordAuditEvent({
    organizationId: org.organizationId,
    actorType: "user",
    actorId: "user-1",
    action: "product.created",
    resourceType: "product",
    resourceId: randomUUID(),
    metadata: { name: "Camisola" },
    requestId: "req-audit",
    ...overrides,
  });
}

test("newest first, paginated, every item matches the published AuditEvent schema", async () => {
  const org = newOrg();
  for (let i = 0; i < 5; i++) await event(org, { metadata: { seq: i } });
  const p1 = await page(org, { pageSize: "2" });
  const p2 = await page(org, { pageSize: "2", page: "2" });
  const p3 = await page(org, { pageSize: "2", page: "3" });
  assert.equal(p1.total, 5);
  const all = [...p1.items, ...p2.items, ...p3.items];
  assert.deepEqual(all.map((e) => (e.metadata as { seq: number }).seq), [4, 3, 2, 1, 0]);
  assert.equal(new Set(all.map((e) => e.id)).size, 5);
  for (const item of all) AuditEventSchema.parse(JSON.parse(JSON.stringify(item)));
  assert.ok(!("organizationId" in all[0]!), "organizationId is implicit in the path, not repeated per event");
});

test("filters: action, actorType, resourceType + resourceId, and the from/to window; totals follow", async () => {
  const org = newOrg();
  const productId = randomUUID();
  await event(org, { action: "product.created", resourceId: productId });
  await event(org, { action: "product.updated", resourceId: productId });
  await event(org, { action: "order.confirmed", resourceType: "order", actorType: "service", actorId: "key-1" });

  assert.equal((await page(org, { action: "product.updated" })).total, 1);
  assert.equal((await page(org, { actorType: "service" })).items[0]?.action, "order.confirmed");
  const forProduct = await page(org, { resourceType: "product", resourceId: productId });
  assert.deepEqual(forProduct.items.map((e) => e.action).sort(), ["product.created", "product.updated"]);
  assert.equal((await page(org, { resourceType: "product", actorType: "service" })).total, 0);

  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60 * 60_000).toISOString();
  assert.equal((await page(org, { from: future })).total, 0);
  assert.equal((await page(org, { from: past, to: future })).total, 3);
  // Pinning `to` freezes the set: an event written afterwards is outside it.
  const pinned = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await event(org, { action: "product.archived" });
  assert.equal((await page(org, { to: pinned })).total, 3);
  assert.equal((await page(org)).total, 4);
});

test("invalid filters are rejected before any query", () => {
  for (const bad of [
    { action: "Product.Created" },
    { action: "x'; DROP TABLE na_pista.audit_events; --" },
    { actorType: "admin" },
    { from: "yesterday" },
    { from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    { metadata: "anything" },
    { sort: "createdAt" },
  ]) {
    assert.equal(listAuditEventsQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("tenant isolation: another organization's events never appear, in rows or totals", async () => {
  const orgA = newOrg();
  const orgB = newOrg();
  await event(orgA);
  await event(orgB);
  await event(orgB);
  const a = await page(orgA, { pageSize: "100" });
  assert.equal(a.total, 1);
  assert.equal((await page(orgB)).total, 2);
  assert.equal((await page(orgA, { page: "2", pageSize: "1" })).items.length, 0);
});

test("defence in depth: secret-looking metadata keys are redacted at any depth; other keys untouched", async () => {
  const org = newOrg();
  await event(org, {
    action: "platform_credential.provisioned",
    resourceType: "platform_credential",
    metadata: {
      platformApiKeyId: "1c5bcdf8-0000-0000-0000-000000000000",
      status: "ACTIVE",
      apiSecret: "should-never-leave",
      nested: { accessToken: "tok", ok: 1, list: [{ password: "p", note: "fine" }] },
      encryptedCredential: "v1:abc:def:ghi",
      authorization: "Bearer xyz",
    },
  });
  const [item] = (await page(org)).items;
  const text = JSON.stringify(item);
  for (const leaked of ["should-never-leave", '"tok"', '"p"', "v1:abc", "Bearer xyz"]) assert.ok(!text.includes(leaked), leaked);
  const m = item!.metadata as Record<string, unknown>;
  assert.equal(m.apiSecret, REDACTED);
  assert.equal(m.encryptedCredential, REDACTED);
  assert.equal(m.authorization, REDACTED);
  assert.equal((m.nested as Record<string, unknown>).accessToken, REDACTED);
  assert.equal(((m.nested as { list: Record<string, unknown>[] }).list[0]!).password, REDACTED);
  assert.equal(((m.nested as { list: Record<string, unknown>[] }).list[0]!).note, "fine");
  assert.equal(m.platformApiKeyId, "1c5bcdf8-0000-0000-0000-000000000000", "an identifier, not a secret");
  assert.equal(m.status, "ACTIVE");
});
