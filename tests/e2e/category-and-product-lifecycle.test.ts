import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/**
 * F20 brief §28, scenarios 1-4 + §33's vertical-slice demonstration,
 * against the real Platform + real Na Pista + real Postgres:
 * OWNER creates category -> creates product -> reads it -> updates it.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("OWNER creates a category", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/categories`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Bebidas", description: "Bebidas e refrigerantes" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgA.id);
  assert.equal(res.data.status, "ACTIVE");
});

test("OWNER creates a product referencing that category, reads it, then updates it", async () => {
  const category = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/categories`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Lacticínios" },
  });
  assert.equal(category.status, 201);

  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Iogurte Natural", description: "500ml", categoryId: category.data.id },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.organizationId, fixtures.orgA.id);
  assert.equal(created.data.categoryId, category.data.id);
  assert.equal(created.data.status, "ACTIVE");

  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(read.status, 200);
  assert.equal(read.data.id, created.data.id);

  const updated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/products/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { description: "500ml, novo fornecedor" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.description, "500ml, novo fornecedor");
  assert.equal(updated.data.name, "Iogurte Natural", "unchanged fields must survive a partial PATCH");
});

test("client-supplied id/organizationId/createdAt/updatedAt in the body are never honored (backend controls protected fields)", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: {
      name: "Protected Fields Probe",
      id: "11111111-1111-1111-1111-111111111111",
      organizationId: "22222222-2222-2222-2222-222222222222",
      createdAt: "2000-01-01T00:00:00.000Z",
    },
  });
  // The extra/protected fields make this a validation error (schemas are
  // `.strict()` — F20 brief §16/§25): the safest, most explicit rejection,
  // never a silent "ignore and use the real values" acceptance.
  assert.equal(res.status, 400);
  assert.equal(res.error.code, "VALIDATION_ERROR");
});

test("invalid input is rejected: empty name, non-uuid categoryId", async () => {
  const emptyName = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "" },
  });
  assert.equal(emptyName.status, 400);

  const badCategory = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "x", categoryId: "not-a-uuid" },
  });
  assert.equal(badCategory.status, 400);
});

test("a non-existent (but well-formed) categoryId is rejected with a clean 400, not a raw FK error", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Orphan category probe", categoryId: "99999999-9999-9999-9999-999999999999" },
  });
  assert.equal(res.status, 400);
  assert.equal(res.error.code, "VALIDATION_ERROR");
  assert.ok(!JSON.stringify(res.error).match(/constraint|foreign key|postgres/i), "must never leak driver/constraint detail");
});

test("DELETE archives, never physically deletes — the resource is still readable afterwards with status ARCHIVED", async () => {
  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "To be archived" },
  });
  const deleted = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/products/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.status, "ARCHIVED");

  const stillReadable = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(stillReadable.status, 200);
  assert.equal(stillReadable.data.status, "ARCHIVED");
});

test("request reference (X-Request-ID) is preserved end to end: echoes a valid client-supplied id, or returns one when absent", async () => {
  const suppliedId = "f20-e2e-probe-123";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/products`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "x-request-id": suppliedId },
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);

  const withoutId = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/products`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  });
  assert.ok(withoutId.headers.get("x-request-id"));
});
