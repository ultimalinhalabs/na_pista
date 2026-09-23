import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF22Fixtures, registerF22Credentials, startApp } from "./inventoryHelpers.js";

/**
 * F22 brief §31 E2E — entitlement. Reuses `catalog.enabled` (ADR-022,
 * unchanged) — no new Platform entitlement invented for Inventory. The
 * live cancel/re-subscribe cycle proving the mechanism itself is real
 * was already exhaustively demonstrated in F19/F20 (unchanged code
 * path) — this file only proves Inventory's own wiring into it: static
 * disabled vs. enabled.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF22Fixtures();

before(async () => {
  ctx = await startApp();
  registerF22Credentials(fixtures);
});
after(() => ctx.close());

test("entitlement disabled (no subscription at all) blocks inventory operations", async () => {
  const noCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/inventory`, { token: fixtures.orgC.ownerToken });
  // org C has no registered service credential either — fail closed 503,
  // distinct from the entitlement-disabled 403 below.
  assert.equal(noCredential.status, 503);
  assert.equal(noCredential.error.code, "UPSTREAM_UNAVAILABLE");

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

  const withCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/inventory`, { token: fixtures.orgC.ownerToken });
  assert.equal(withCredential.status, 403);
  assert.equal(withCredential.error.code, "ENTITLEMENT_REQUIRED");
});

test("entitlement enabled (active NA_PISTA/BUSINESS subscription) permits inventory operations", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/inventory`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 200);
});
