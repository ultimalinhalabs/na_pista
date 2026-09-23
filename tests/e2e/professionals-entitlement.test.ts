import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF25Fixtures, registerF25Credentials, startApp } from "./professionalsHelpers.js";

/**
 * F25 brief §38 E2E item 5. Reuses `catalog.enabled` (ADR-022, unchanged)
 * — no new Platform entitlement invented for Professionals. "Platform
 * unavailable fails closed" is deliberately NOT re-proven with a full
 * HTTP round trip here — already exhaustively covered, module-
 * agnostically, by `tests/e2e/customers-platform-unavailable.test.ts`
 * — Professionals' entitlement gate calls that exact same function.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF25Fixtures();

before(async () => {
  ctx = await startApp();
  registerF25Credentials(fixtures);
});
after(() => ctx.close());

test("5: entitlement disabled (no subscription at all) blocks Professional operations", async () => {
  const noCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/professionals`, { token: fixtures.orgC.ownerToken });
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

  const withCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/professionals`, { token: fixtures.orgC.ownerToken });
  assert.equal(withCredential.status, 403);
  assert.equal(withCredential.error.code, "ENTITLEMENT_REQUIRED");
});

test("entitlement enabled (active NA_PISTA/BUSINESS subscription) permits Professional operations", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 200);
});
