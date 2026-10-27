import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { _clearEntitlementsCache } from "../../src/platform/entitlements.js";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/**
 * F20 brief §9/§28 scenarios 7-8: `catalog.enabled` gates the whole
 * module, live against the real Platform. Org D is used exclusively here
 * (revoke/re-grant access, then cancel) — no other test file touches it.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadFixtures();

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("entitlement disabled (no subscription at all) blocks Products and Categories", async () => {
  const products = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/products`, { token: fixtures.orgC.ownerToken });
  assert.equal(products.status, 503, "org C has no registered service credential at all -> fail closed 503, distinct from entitlement-disabled 403");

  // Register a credential for org C on the fly to isolate "no credential"
  // from "no entitlement" — org C genuinely has no subscription, so once
  // a credential exists the result must be 403 ENTITLEMENT_REQUIRED.
  const { registerServiceCredential } = await import("../../src/platform/serviceAuth.js");
  const keyRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgC.id}/api-keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgC.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] }),
  });
  assert.equal(keyRes.status, 201);
  const key = (await keyRes.json()).data;
  registerServiceCredential(fixtures.orgC.id, key.secret);

  const afterCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/products`, { token: fixtures.orgC.ownerToken });
  assert.equal(afterCredential.status, 403);
  assert.equal(afterCredential.error.code, "ENTITLEMENT_REQUIRED");
});

test("entitlement enabled (active subscription) allows Products; revoking then re-granting access live toggles it; canceling ends it", async () => {
  const probe = (label: string) =>
    call(ctx.base, "POST", `/organizations/${fixtures.orgD.id}/products`, { token: fixtures.orgD.ownerToken, body: { name: `F20 Entitlement Probe D (${label})` } });
  const access = (method: "PUT" | "DELETE") =>
    fetch(`${fixtures.platformBaseUrl}/platform/organizations/${fixtures.orgD.id}/applications/NA_PISTA/access`, {
      method,
      headers: { authorization: `Bearer ${fixtures.platformAdmin.token}`, "content-type": "application/json" },
    });

  // 1) org D starts subscribed -> allowed.
  assert.equal((await probe("before")).status, 201);

  // 2) a platform admin revokes the application access for real -> blocked; re-grants it -> allowed again,
  //    proving the gate is live in both directions, not a one-way switch.
  assert.equal((await access("DELETE")).status, 200);
  _clearEntitlementsCache();
  const afterRevoke = await probe("should be blocked");
  assert.equal(afterRevoke.status, 403);
  assert.equal(afterRevoke.error.code, "ENTITLEMENT_REQUIRED");

  assert.equal((await access("PUT")).status, 200);
  _clearEntitlementsCache();
  assert.equal((await probe("re-enabled")).status, 201);

  // 3) the owner cancels the subscription for real -> blocked. Subscribing again is a contract (UL plans are not
  //    self-service since ul-platform 1590646), so this direction is one-way here by design.
  const cancelRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgD.id}/subscriptions/${fixtures.orgD.subscriptionId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${fixtures.orgD.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "canceled" }),
  });
  assert.equal(cancelRes.status, 200);
  _clearEntitlementsCache();
  const afterCancel = await probe("after cancel");
  assert.equal(afterCancel.status, 403);
  assert.equal(afterCancel.error.code, "ENTITLEMENT_REQUIRED");
});
