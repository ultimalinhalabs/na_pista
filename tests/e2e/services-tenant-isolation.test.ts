import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createService, loadF24Fixtures, registerF24Credentials, startApp } from "./servicesHelpers.js";

/** F24 brief §21 E2E item 6 — cross-tenant Service access, over HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF24Fixtures();

before(async () => {
  ctx = await startApp();
  registerF24Credentials(fixtures);
});
after(() => ctx.close());

test("organization A cannot list, GET, or update organization B's Services", async () => {
  const serviceB = await createService(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Serviço B Isolamento", 30);

  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/services/${serviceB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(getAsA.status, 403, "owner A has no membership in org B -> blocked before ever reaching the row");

  const updateAsA = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgB.id}/services/${serviceB.id}`, { token: fixtures.orgA.ownerToken, body: { name: "hacked" } });
  assert.equal(updateAsA.status, 403);

  const archiveAsA = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgB.id}/services/${serviceB.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });
  assert.equal(archiveAsA.status, 403);

  const listAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken });
  assert.ok(!listAsA.data.some((s: { id: string }) => s.id === serviceB.id));
});

test("an org-B service id used on org A's own path (real membership, wrong resource) resolves 404, never the row", async () => {
  const serviceB = await createService(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Serviço B Cross-id Probe", 30);
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services/${serviceB.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 404);
});

test("a service credential scoped to org A cannot operate on org B (cross-tenant credential use)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/services`, { token: fixtures.apiKeys.integrationA.secret });
  assert.equal(res.status, 403);
});
