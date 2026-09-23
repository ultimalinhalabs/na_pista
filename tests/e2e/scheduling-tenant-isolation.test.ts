import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, createService, loadF26Fixtures, registerF26Credentials, setTimezone, startApp } from "./schedulingHelpers.js";

/** F26 brief §31 "Tenancy" — cross-tenant Professional/Service/settings access, over real HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF26Fixtures();

before(async () => {
  ctx = await startApp();
  registerF26Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken);
  await setTimezone(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Europe/Lisbon");
});
after(() => ctx.close());

test("organization A cannot read or replace organization B's Professional's schedule", async () => {
  const professionalB = await createProfessional(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Profissional B Isolamento Agenda");

  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/professionals/${professionalB.id}/schedule`, { token: fixtures.orgA.ownerToken });
  assert.equal(getAsA.status, 403, "owner A has no membership in org B -> blocked before ever reaching the row");

  const putAsA = await call(ctx.base, "PUT", `/organizations/${fixtures.orgB.id}/professionals/${professionalB.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [] },
  });
  assert.equal(putAsA.status, 403);
});

test("an org-B professional id used on org A's own path (real membership, wrong resource) resolves 404, never the row", async () => {
  const professionalB = await createProfessional(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Profissional B Cross-id Agenda");
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professionalB.id}/schedule`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 404);
});

test("organization A cannot use organization B's Service to compute availability for org A's own Professional", async () => {
  const professionalA = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional A Cross-Service Agenda");
  const serviceB = await createService(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Serviço B Cross Agenda", 30);

  const res = await call(
    ctx.base,
    "GET",
    `/organizations/${fixtures.orgA.id}/professionals/${professionalA.id}/availability?from=2026-09-28&to=2026-09-28&serviceId=${serviceB.id}`,
    { token: fixtures.orgA.ownerToken },
  );
  assert.equal(res.status, 404);
  assert.equal(res.error.code, "NOT_FOUND");
});

test("organization A cannot read organization B's settings, and vice-versa", async () => {
  const asA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/settings`, { token: fixtures.orgA.ownerToken });
  assert.equal(asA.status, 403, "owner A has no membership in org B");

  const orgASettings = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken });
  const orgBSettings = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/settings`, { token: fixtures.orgB.ownerToken });
  assert.notEqual(orgASettings.data.timezone, orgBSettings.data.timezone, "each organization's timezone is independent");
});

test("a service credential scoped to org A cannot operate on org B (cross-tenant credential use)", async () => {
  const professionalB = await createProfessional(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Profissional B Credential Isolamento");
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/professionals/${professionalB.id}/schedule`, { token: fixtures.apiKeys.integrationA.secret });
  assert.equal(res.status, 403);
});
