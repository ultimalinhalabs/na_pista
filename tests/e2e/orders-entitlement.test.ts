import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/**
 * F23 brief §41 E2E items 26/27/32. Reuses `catalog.enabled` (ADR-022,
 * unchanged) — no new Platform entitlement invented for Orders (F23
 * brief §28). Item 32 ("Platform unavailable fails closed") is
 * deliberately NOT re-proven with a full HTTP round trip here — it is
 * already exhaustively covered, module-agnostically, by
 * `tests/e2e/customers-platform-unavailable.test.ts` (tests the shared
 * `callPlatform` client directly, unchanged by this phase) — Orders'
 * entitlement gate calls that exact same function.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF23Fixtures();

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fixtures);
});
after(() => ctx.close());

test("26: entitlement disabled (no subscription at all) blocks Order operations", async () => {
  const noCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/orders`, { token: fixtures.orgC.ownerToken });
  assert.equal(noCredential.status, 503);
  assert.equal(noCredential.error.code, "UPSTREAM_UNAVAILABLE");

  const { registerServiceCredential } = await import("../../src/platform/serviceAuth.js");
  const keyRes = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgC.id}/api-keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgC.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] }),
  });
  assert.equal(keyRes.status, 201);
  const key = (await keyRes.json()).data;
  registerServiceCredential(fixtures.orgC.id, key.secret);

  const withCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/orders`, { token: fixtures.orgC.ownerToken });
  assert.equal(withCredential.status, 403);
  assert.equal(withCredential.error.code, "ENTITLEMENT_REQUIRED");
});

test("27: entitlement enabled (active NA_PISTA/BUSINESS subscription) permits Order operations", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/orders`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 200);
});
