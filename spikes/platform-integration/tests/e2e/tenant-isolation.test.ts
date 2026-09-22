import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadFixtures, registerFixtureCredentials, startSpike } from "./helpers.js";

/**
 * F19 §8/§16: cross-tenant access must be blocked, proved with two
 * organizations that BOTH have real NA_PISTA access (org A and org D) so
 * the result is never confused with an entitlement-gating rejection.
 */
let ctx: Awaited<ReturnType<typeof startSpike>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startSpike();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("owner A creates a product in org A -> 201, scoped to org A", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "F19 Product A1" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgA.id);
});

test("owner D creates a product in org D -> 201, scoped to org D", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgD.id}/products`, {
    token: fixtures.orgD.ownerToken,
    body: { name: "F19 Product D1" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgD.id);
});

test("owner D has no membership in org A -> 403 on org A's path", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgD.ownerToken,
  });
  assert.equal(res.status, 403);
});

test("owner A has no membership in org D -> 403 on org D's path", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgD.id}/products`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(res.status, 403);
});

test("an outsider (no membership anywhere) -> 403 on org A's path", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.outsider.token,
  });
  assert.equal(res.status, 403);
});

test("org A's product list never contains org D's products, and vice versa", async () => {
  const a = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.orgA.ownerToken });
  const d = await call(ctx.base, "GET", `/organizations/${fixtures.orgD.id}/products`, { token: fixtures.orgD.ownerToken });
  assert.ok(a.data.every((p: any) => p.organizationId === fixtures.orgA.id));
  assert.ok(d.data.every((p: any) => p.organizationId === fixtures.orgD.id));
  const aIds = new Set(a.data.map((p: any) => p.id));
  const dIds = new Set(d.data.map((p: any) => p.id));
  assert.equal([...aIds].some((id) => dIds.has(id)), false);
});

test("owner D reading org A's specific product by id (via D's own valid membership check first) is blocked at the membership gate, never reaches the row", async () => {
  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "F19 Product A2 (target)" },
  });
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products/${created.data.id}`, {
    token: fixtures.orgD.ownerToken,
  });
  assert.equal(res.status, 403); // no membership in A at all — never gets to the repository
});

test("a service credential scoped to org A cannot read org D's products (wrong-tenant credential use, not just wrong-tenant human)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgD.id}/products`, {
    token: fixtures.apiKeys.integrationA.secret,
  });
  assert.equal(res.status, 403);
});

test("an org-A-scoped id used on org D's path resolves as not-found from D's own table, not as A's row leaking through", async () => {
  const createdInA = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "F19 Product A3 (cross-id probe)" },
  });
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgD.id}/products/${createdInA.data.id}`, {
    token: fixtures.orgD.ownerToken, // owner D DOES have membership in D — reaches the repository this time
  });
  assert.equal(res.status, 404); // tenancy.md §3: cross-tenant id lookup is 404, never 403, never the row
});
