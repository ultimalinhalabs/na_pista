import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createService, loadF24Fixtures, registerF24Credentials, startApp } from "./servicesHelpers.js";

/**
 * F24 brief §21 E2E items 2/3/4. Revoked/expired service credential AND
 * revoked membership behavior are deliberately NOT re-proven here —
 * both are exhaustively covered by F19's own spike (8 dedicated
 * credential tests + membership-revocation coverage in
 * `spikes/platform-integration/tests/e2e/authorization.test.ts`) and
 * reused unchanged by every phase since (F20-F23); this file only
 * proves Services' own wiring into the same, unchanged mechanisms.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF24Fixtures();

before(async () => {
  ctx = await startApp();
  registerF24Credentials(fixtures);
});
after(() => ctx.close());

test("2: authenticated member (STAFF) can read Services but is denied from creating or updating them", async () => {
  const created = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço STAFF Probe", 30);

  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.staffA.token, body: { name: "x", durationMinutes: 30 } });
  assert.equal(create.status, 403);
  assert.equal(create.error.code, "FORBIDDEN");

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.staffA.token, body: { name: "hacked" } });
  assert.equal(update.status, 403);

  const archive = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.staffA.token, body: { status: "ARCHIVED" } });
  assert.equal(archive.status, 403);
});

test("2: authenticated member (MANAGER) can create, update, archive, and reactivate Services (no services.delete tier)", async () => {
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.managerA.token, body: { name: "Serviço MANAGER Probe", durationMinutes: 30 } });
  assert.equal(create.status, 201);

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${create.data.id}`, { token: fixtures.managerA.token, body: { durationMinutes: 45 } });
  assert.equal(update.status, 200);

  const archive = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${create.data.id}`, { token: fixtures.managerA.token, body: { status: "ARCHIVED" } });
  assert.equal(archive.status, 200, "MANAGER can archive too — no OWNER/ADMIN-only tier for Services (F24A/ADR-033 §14)");

  const reactivate = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${create.data.id}`, { token: fixtures.managerA.token, body: { status: "ACTIVE" } });
  assert.equal(reactivate.status, 200);
});

test("a service credential with sufficient scope (catalog.write) can create and update a Service on its own organization", async () => {
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.apiKeys.integrationA.secret, body: { name: "Serviço Service Credential", durationMinutes: 30 } });
  assert.equal(create.status, 201);
});

test("a service credential with insufficient scope (usage.write/event.publish only, no catalog.write) is blocked from writing", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.apiKeys.platformFacingA.secret, body: { name: "x", durationMinutes: 30 } });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, "FORBIDDEN");
});

test("3: no Authorization header -> 401 (unauthenticated user)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services`);
  assert.equal(res.status, 401);
});
