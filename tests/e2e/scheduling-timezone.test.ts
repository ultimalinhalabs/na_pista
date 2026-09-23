import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, loadF26Fixtures, registerF26Credentials, startApp } from "./schedulingHelpers.js";

/** F26 brief §31 "Timezone" — configure/invalid/unset, and availability blocked without one. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF26Fixtures();

before(async () => {
  ctx = await startApp();
  registerF26Credentials(fixtures);
});
after(() => ctx.close());

test("configure timezone: OWNER sets a valid IANA timezone, GET reflects it", async () => {
  const put = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken, body: { timezone: "Africa/Luanda" } });
  assert.equal(put.status, 200);
  assert.equal(put.data.timezone, "Africa/Luanda");

  const get = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken });
  assert.equal(get.data.timezone, "Africa/Luanda");
});

test("invalid timezone: a raw UTC offset or nonexistent identifier is rejected with 400, never silently accepted", async () => {
  const offset = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken, body: { timezone: "+01:00" } });
  assert.equal(offset.status, 400);
  assert.equal(offset.error.code, "VALIDATION_ERROR");

  const nonexistent = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken, body: { timezone: "Not/A_Real_Zone" } });
  assert.equal(nonexistent.status, 400);
});

/**
 * Both tests below mint a FRESH, dedicated, subscribed organization
 * inline via the real Platform API — deliberately not reusing
 * `fixtures.orgB`, which every other scheduling E2E file's `before()`
 * hook may already have configured a timezone for (all files share one
 * fixture set and can run in the same process). Cross-file shared-state
 * is exactly the kind of test-isolation bug this project's own
 * conventions warn against — a fresh org here is the correct fix, not
 * a file-run-order workaround.
 */
async function createFreshSubscribedOrg() {
  const ownerToken = fixtures.orgA.ownerToken; // any authenticated user can create further orgs of their own
  const org = await call(fixtures.platformBaseUrl, "POST", "/organizations", { token: ownerToken, body: { name: `F26_TZ_PROBE_${Date.now()}` } });
  if (org.status !== 201) throw new Error(`failed to create probe org: ${org.status} ${JSON.stringify(org.error)}`);
  // `ownerToken` was already used by earlier tests in this file, so its
  // identity/memberships may already be cached (`resolveIdentity`, OD-13,
  // 15s TTL) from before this new membership existed — force a fresh
  // GET /me for the next request, the same fix F20's own
  // entitlements.test.ts applies (`_clearEntitlementsCache`) for the
  // analogous subscription-cache case.
  const { _clearMembershipCache } = await import("../../src/platform/membership.js");
  _clearMembershipCache();
  const subscription = await call(fixtures.platformBaseUrl, "POST", `/organizations/${org.data.id}/subscriptions`, {
    token: ownerToken,
    body: { applicationKey: "NA_PISTA", planKey: "BUSINESS" },
  });
  if (subscription.status !== 201) throw new Error(`failed to subscribe probe org: ${subscription.status} ${JSON.stringify(subscription.error)}`);
  const apiKey = await call(fixtures.platformBaseUrl, "POST", `/organizations/${org.data.id}/api-keys`, {
    token: ownerToken,
    body: { applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] },
  });
  const { registerServiceCredential } = await import("../../src/platform/serviceAuth.js");
  registerServiceCredential(org.data.id, apiKey.data.secret);
  return { id: org.data.id, ownerToken };
}

test("unset timezone: GET .../settings for an organization that never configured one returns null, not an error and not a silent default", async () => {
  const org = await createFreshSubscribedOrg();
  const res = await call(ctx.base, "GET", `/organizations/${org.id}/settings`, { token: org.ownerToken });
  assert.equal(res.status, 200);
  assert.equal(res.data, null);
});

test("availability blocked without timezone: a real 409 TIMEZONE_NOT_CONFIGURED, never a silent UTC/server/browser default", async () => {
  const org = await createFreshSubscribedOrg();
  const professional = await createProfessional(ctx.base, org.id, org.ownerToken, "Profissional Sem Timezone E2E");
  const res = await call(ctx.base, "GET", `/organizations/${org.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28`, {
    token: org.ownerToken,
  });
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "TIMEZONE_NOT_CONFIGURED");

  await call(ctx.base, "PUT", `/organizations/${org.id}/settings`, { token: org.ownerToken, body: { timezone: "Europe/Lisbon" } });
  const afterConfigured = await call(ctx.base, "GET", `/organizations/${org.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28`, {
    token: org.ownerToken,
  });
  assert.equal(afterConfigured.status, 200, "now that the timezone is configured, availability computes successfully");
});

test("STAFF can read organization settings but cannot update the timezone", async () => {
  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const write = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.staffA.token, body: { timezone: "Africa/Luanda" } });
  assert.equal(write.status, 403);
});
