import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF21Fixtures, registerF21Credentials, startApp } from "./customersHelpers.js";

/**
 * F21 brief §19 matrix items 5, 6, 20, 21. Revoked/expired service
 * credential behavior is deliberately NOT re-proven here — that
 * mechanism (Platform introspection via GET /v1/service/me) is
 * exhaustively covered by F19 (8 dedicated tests) and reused unchanged
 * by F20; this file only proves Customers' OWN wiring into it (F21
 * brief §19 "Do not duplicate F19/F20 tests unnecessarily").
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF21Fixtures();

before(async () => {
  ctx = await startApp();
  registerF21Credentials(fixtures);
});
after(() => ctx.close());

test("STAFF can read customers but is denied from creating, updating or archiving them", async () => {
  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.staffA.token,
    body: { name: "STAFF should not be able to create this" },
  });
  assert.equal(create.status, 403);
  assert.equal(create.error.code, "FORBIDDEN");

  const customer = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Owner-created, STAFF should not modify" },
  });

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/customers/${customer.data.id}`, {
    token: fixtures.staffA.token,
    body: { name: "hacked" },
  });
  assert.equal(update.status, 403);

  const archive = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/customers/${customer.data.id}`, {
    token: fixtures.staffA.token,
  });
  assert.equal(archive.status, 403);
});

test("MANAGER can create and update customers but cannot archive them (delete is OWNER/ADMIN-only, F21 brief §9)", async () => {
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.managerA.token,
    body: { name: "Manager-created Customer" },
  });
  assert.equal(create.status, 201);

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/customers/${create.data.id}`, {
    token: fixtures.managerA.token,
    body: { notes: "updated by manager" },
  });
  assert.equal(update.status, 200);

  const archive = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/customers/${create.data.id}`, {
    token: fixtures.managerA.token,
  });
  assert.equal(archive.status, 403);
});

test("a service credential with sufficient scope (catalog.write) can create a customer on its own organization", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.apiKeys.integrationA.secret,
    body: { name: "Service-created Customer" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgA.id);
});

test("a service credential with insufficient scope (no scopes granted) is blocked", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.apiKeys.noScopeA.secret,
  });
  assert.equal(res.status, 403);
});

test("no membership at all -> 403; no Authorization header -> 401", async () => {
  const noMembership = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers`, { token: fixtures.outsider.token });
  assert.equal(noMembership.status, 403);

  const noAuth = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers`);
  assert.equal(noAuth.status, 401);
});
