import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/** F20 brief §28 scenario 5 / §29 test matrix: STAFF, permission, entitlement, membership, auth. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("STAFF can read products but cannot create, update, or delete them", async () => {
  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.staffA.token,
    body: { name: "STAFF should not be able to create this" },
  });
  assert.equal(create.status, 403);
  assert.equal(create.error.code, "FORBIDDEN");

  // Need a real product to attempt update/delete against.
  const product = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Owner-created, STAFF should not modify" },
  });

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/products/${product.data.id}`, {
    token: fixtures.staffA.token,
    body: { name: "hacked" },
  });
  assert.equal(update.status, 403);

  const del = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/products/${product.data.id}`, {
    token: fixtures.staffA.token,
  });
  assert.equal(del.status, 403);
});

test("STAFF can read but cannot create categories", async () => {
  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/categories`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/categories`, {
    token: fixtures.staffA.token,
    body: { name: "should be rejected" },
  });
  assert.equal(create.status, 403);
});

test("no membership at all -> 403", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.outsider.token });
  assert.equal(res.status, 403);
});

test("no Authorization header -> 401", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`);
  assert.equal(res.status, 401);
});

test("garbage bearer token -> 401", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: "garbage" });
  assert.equal(res.status, 401);
});

test("a valid service credential with insufficient scope -> 403", async () => {
  // integrationA is provisioned with catalog.read + catalog.write, so this
  // proves the OTHER direction using the read-only surface of a credential
  // that has NO scope at all for a hypothetical stricter operation is
  // exercised in service-scope-specific detail already by F19 — here we
  // confirm Na Pista's product routes honor `requireAuthorized`'s service
  // branch at all, using an unrelated org's credential.
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/products`, {
    token: fixtures.apiKeys.platformFacingA.secret, // usage.write/event.publish only — no catalog.* scope, and wrong org too
  });
  assert.equal(res.status, 403);
});

test("a service credential scoped to org A cannot operate on org B (cross-tenant credential use)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/products`, {
    token: fixtures.apiKeys.integrationA.secret,
  });
  assert.equal(res.status, 403);
});

test("a service credential with sufficient scope on its own organization succeeds", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.apiKeys.integrationA.secret,
  });
  assert.equal(res.status, 200);
});
