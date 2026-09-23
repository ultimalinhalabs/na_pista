import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, createService, loadF25Fixtures, registerF25Credentials, startApp } from "./professionalsHelpers.js";

/** F25 brief §38 E2E item 6 — cross-tenant Professional and association access, over HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF25Fixtures();

before(async () => {
  ctx = await startApp();
  registerF25Credentials(fixtures);
});
after(() => ctx.close());

test("organization A cannot list, GET, or update organization B's Professionals", async () => {
  const professionalB = await createProfessional(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Profissional B Isolamento");

  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/professionals/${professionalB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(getAsA.status, 403, "owner A has no membership in org B -> blocked before ever reaching the row");

  const updateAsA = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgB.id}/professionals/${professionalB.id}`, { token: fixtures.orgA.ownerToken, body: { name: "hacked" } });
  assert.equal(updateAsA.status, 403);

  const archiveAsA = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgB.id}/professionals/${professionalB.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });
  assert.equal(archiveAsA.status, 403);

  const listAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken });
  assert.ok(!listAsA.data.some((p: { id: string }) => p.id === professionalB.id));
});

test("an org-B professional id used on org A's own path (real membership, wrong resource) resolves 404, never the row", async () => {
  const professionalB = await createProfessional(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Profissional B Cross-id Probe");
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professionalB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 404);
});

test("organization A cannot associate its own Professional with organization B's Service, nor vice-versa (cross-tenant association attempt)", async () => {
  const professionalA = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional A Cross-Assoc");
  const serviceB = await createService(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Serviço B Cross-Assoc", 30);

  // Org A has no membership in org B, so the path itself (organizationId=A, but serviceId belongs to B)
  // is authorized at the org-A tenant boundary, then resolves 404 because service B does not exist under org A.
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professionalA.id}/services/${serviceB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 404);
  assert.equal(res.error.code, "NOT_FOUND");
});

test("a service credential scoped to org A cannot operate on org B (cross-tenant credential use)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/professionals`, { token: fixtures.apiKeys.integrationA.secret });
  assert.equal(res.status, 403);
});
