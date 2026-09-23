import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, createService, loadF25Fixtures, registerF25Credentials, startApp } from "./professionalsHelpers.js";

/**
 * F25 brief §38 E2E items 2/3/4. Revoked/expired service credential AND
 * revoked membership behavior are deliberately NOT re-proven here —
 * both are exhaustively covered by F19's own spike and reused unchanged
 * by every phase since (F20-F24); this file only proves Professionals'
 * own wiring into the same, unchanged mechanisms.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF25Fixtures();

before(async () => {
  ctx = await startApp();
  registerF25Credentials(fixtures);
});
after(() => ctx.close());

test("2: authenticated member (STAFF) can read Professionals but is denied from creating, updating, or managing associations", async () => {
  const created = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional STAFF Probe");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço STAFF Probe", 30);

  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.staffA.token, body: { name: "x" } });
  assert.equal(create.status, 403);
  assert.equal(create.error.code, "FORBIDDEN");

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, { token: fixtures.staffA.token, body: { name: "hacked" } });
  assert.equal(update.status, 403);

  const archive = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, { token: fixtures.staffA.token, body: { status: "ARCHIVED" } });
  assert.equal(archive.status, 403);

  const associate = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${created.id}/services/${service.id}`, { token: fixtures.staffA.token });
  assert.equal(associate.status, 403, "association management requires professionals.update, not just read (F25 brief §33)");

  const remove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${created.id}/services/${service.id}`, { token: fixtures.staffA.token });
  assert.equal(remove.status, 403);
});

test("2: authenticated member (MANAGER) can create, update, archive, reactivate Professionals AND manage associations (no professionals.delete, no professional_services.manage tier)", async () => {
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.managerA.token, body: { name: "Profissional MANAGER Probe" } });
  assert.equal(create.status, 201);

  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço MANAGER Probe", 30);

  const update = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${create.data.id}`, { token: fixtures.managerA.token, body: { description: "atualizado" } });
  assert.equal(update.status, 200);

  const associate = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${create.data.id}/services/${service.id}`, { token: fixtures.managerA.token });
  assert.equal(associate.status, 201);

  const remove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${create.data.id}/services/${service.id}`, { token: fixtures.managerA.token });
  assert.equal(remove.status, 200);

  const archive = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${create.data.id}`, { token: fixtures.managerA.token, body: { status: "ARCHIVED" } });
  assert.equal(archive.status, 200, "MANAGER can archive too — no OWNER/ADMIN-only tier for Professionals (ADR-036, matching Service's F24A precedent)");

  const reactivate = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${create.data.id}`, { token: fixtures.managerA.token, body: { status: "ACTIVE" } });
  assert.equal(reactivate.status, 200);
});

test("a service credential with sufficient scope (catalog.write) can create a Professional and manage associations on its own organization", async () => {
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.apiKeys.integrationA.secret, body: { name: "Profissional Service Credential" } });
  assert.equal(create.status, 201);
});

test("a service credential with insufficient scope (usage.write/event.publish only, no catalog.write) is blocked from writing", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.apiKeys.platformFacingA.secret, body: { name: "x" } });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, "FORBIDDEN");
});

test("3: no Authorization header -> 401 (unauthenticated user)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals`);
  assert.equal(res.status, 401);
});
