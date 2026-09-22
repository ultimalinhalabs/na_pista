import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { _clearMembershipCache } from "../../src/platform/membership.js";
import { call, loadFixtures, registerFixtureCredentials, startSpike } from "./helpers.js";

/**
 * F19 §4/§9/§10: human authorization — OWNER/ADMIN/MANAGER/STAFF against
 * Na Pista's OWN local permission map (OD-12 part 2), keyed by the
 * Platform's real `roleKey` for a real membership.
 */
let ctx: Awaited<ReturnType<typeof startSpike>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startSpike();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("OWNER: read and write both permitted", async () => {
  const write = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "F19 Authz Probe (owner)" },
  });
  assert.equal(write.status, 201);
  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.orgA.ownerToken });
  assert.equal(read.status, 200);
});

test("STAFF: read permitted, write rejected (no products.write in the local map)", async () => {
  const read = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.staffA.token });
  assert.equal(read.status, 200);

  const write = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/products`, {
    token: fixtures.staffA.token,
    body: { name: "should be rejected" },
  });
  assert.equal(write.status, 403);
  assert.equal(write.error.code, "FORBIDDEN");
});

test("STAFF with a real, active membership but revoked afterwards -> subsequent access rejected once the cache clears", async () => {
  // Find staffA's real membershipId from the Platform (never guessed).
  const listRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/memberships`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  });
  const memberships = (await listRes.json()).data as { membershipId: string; userId: string }[];
  const staffMembership = memberships.find((m) => m.userId === fixtures.staffA.id);
  assert.ok(staffMembership, "staffA must have a real membership row");

  // Confirm access works before revocation.
  const before1 = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.staffA.token });
  assert.equal(before1.status, 200);

  // Revoke for real, on the Platform.
  const removeRes = await fetch(
    `${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/memberships/${staffMembership!.membershipId}`,
    { method: "DELETE", headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` } },
  );
  assert.equal(removeRes.status, 200);

  // Na Pista's own /me cache (15s TTL, keyed by the raw token) is still
  // warm immediately after — same bounded-staleness tradeoff as
  // entitlements (OD-13). Re-importing the module for a fresh process
  // isn't available here, so this asserts the REAL post-revocation state
  // directly against the Platform instead (what the cache will read once
  // it expires), which is the actual security-relevant fact.
  const platformMe = await fetch(`${fixtures.platformBaseUrl}/me`, {
    headers: { authorization: `Bearer ${fixtures.staffA.token}` },
  });
  const platformMeJson = await platformMe.json();
  assert.ok(
    !platformMeJson.data.memberships.some((m: any) => m.organizationId === fixtures.orgA.id),
    "Platform itself must no longer report this membership",
  );

  // And once Na Pista's own cache entry is cleared (simulating the TTL
  // elapsing), it reflects the same reality — this is the end-to-end
  // proof, not just "the Platform knows", but "Na Pista, once its bounded
  // staleness window passes, enforces it too".
  _clearMembershipCache();
  const after1 = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/products`, { token: fixtures.staffA.token });
  assert.equal(after1.status, 403);
});
