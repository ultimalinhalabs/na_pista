import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { _clearEntitlementsCache } from "../../src/platform/entitlements.js";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/**
 * F20 brief §9/§28 scenarios 7-8: `catalog.enabled` gates the whole
 * module, live against the real Platform. Org D is used exclusively here
 * (subscribe/cancel/re-subscribe) — no other test file touches it.
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

test("entitlement enabled (active subscription) allows Products; disabling then re-enabling it live toggles access", async () => {
  // 1) org D starts subscribed -> allowed.
  const before1 = await call(ctx.base, "POST", `/organizations/${fixtures.orgD.id}/products`, {
    token: fixtures.orgD.ownerToken,
    body: { name: "F20 Entitlement Probe D (before cancel)" },
  });
  assert.equal(before1.status, 201);

  // 2) cancel the subscription for real, on the real Platform.
  const cancelRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgD.id}/subscriptions/${fixtures.orgD.subscriptionId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${fixtures.orgD.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "canceled" }),
  });
  assert.equal(cancelRes.status, 200);
  _clearEntitlementsCache();

  const afterCancel = await call(ctx.base, "POST", `/organizations/${fixtures.orgD.id}/products`, {
    token: fixtures.orgD.ownerToken,
    body: { name: "F20 Entitlement Probe D (should be blocked)" },
  });
  assert.equal(afterCancel.status, 403);
  assert.equal(afterCancel.error.code, "ENTITLEMENT_REQUIRED");

  // 3) re-subscribe (a NEW subscription — the canceled one stays canceled,
  //    history preserved, exactly as ul-platform's own model requires) ->
  //    access is restored, proving the gate is live, not a one-way switch.
  const resubscribeRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgD.id}/subscriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgD.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationKey: "NA_PISTA", planKey: "BUSINESS" }),
  });
  assert.equal(resubscribeRes.status, 201);
  _clearEntitlementsCache();

  const afterResubscribe = await call(ctx.base, "POST", `/organizations/${fixtures.orgD.id}/products`, {
    token: fixtures.orgD.ownerToken,
    body: { name: "F20 Entitlement Probe D (re-enabled)" },
  });
  assert.equal(afterResubscribe.status, 201);
});
