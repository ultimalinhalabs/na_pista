import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF21Fixtures, registerF21Credentials, startApp } from "./customersHelpers.js";

/** F21 brief §19 matrix items 7-12. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF21Fixtures();

before(async () => {
  ctx = await startApp();
  registerF21Credentials(fixtures);
});
after(() => ctx.close());

test("organization A cannot list, GET, PATCH, or archive organization B's customers", async () => {
  const customerB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/customers`, {
    token: fixtures.orgB.ownerToken,
    body: { name: "Customer B (isolation target)" },
  });
  assert.equal(customerB.status, 201);

  const listAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers`, { token: fixtures.orgA.ownerToken });
  assert.ok(!listAsA.data.some((c: any) => c.id === customerB.data.id));

  // Owner A has no membership in org B -> blocked before ever reaching the row.
  const getAsA = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/customers/${customerB.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(getAsA.status, 403);

  const patchAsA = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgB.id}/customers/${customerB.data.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "hacked" },
  });
  assert.equal(patchAsA.status, 403);

  const archiveAsA = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgB.id}/customers/${customerB.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(archiveAsA.status, 403);
});

test("customerId manipulation: an org-B id used on org A's own path (real membership, wrong resource) resolves 404, never the row", async () => {
  const customerB = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/customers`, {
    token: fixtures.orgB.ownerToken,
    body: { name: "Customer B (cross-id probe)" },
  });
  // Owner A DOES have membership in org A — this reaches the repository,
  // which must not find org B's row under org A's tenant filter.
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/customers/${customerB.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(res.status, 404);
});

test("organizationId manipulation: a well-formed but nonexistent organizationId in the path is rejected the same way (no membership -> 403)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/99999999-9999-9999-9999-999999999999/customers`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(res.status, 403);
});

test("a service credential scoped to org A cannot operate on org B (cross-tenant credential use)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/customers`, {
    token: fixtures.apiKeys.integrationA.secret,
  });
  assert.equal(res.status, 403);
});
