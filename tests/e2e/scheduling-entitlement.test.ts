import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF26Fixtures, registerF26Credentials, setTimezone, startApp } from "./schedulingHelpers.js";

/**
 * F26 brief §31 "Entitlement" — reuses `catalog.enabled` (ADR-039/040),
 * no new Platform entitlement invented for Scheduling. "Platform
 * unavailable fails closed" is deliberately NOT re-proven with a full
 * HTTP round trip — already exhaustively covered, module-agnostically,
 * by `tests/e2e/customers-platform-unavailable.test.ts`.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF26Fixtures();

before(async () => {
  ctx = await startApp();
  registerF26Credentials(fixtures);
});
after(() => ctx.close());

test("entitlement disabled (no subscription at all) blocks Scheduling operations", async () => {
  const noCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/professionals/${fixtures.orgC.id}/schedule`, { token: fixtures.orgC.ownerToken });
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

  const withCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/professionals/${fixtures.orgC.id}/schedule`, { token: fixtures.orgC.ownerToken });
  assert.equal(withCredential.status, 403);
  assert.equal(withCredential.error.code, "ENTITLEMENT_REQUIRED");

  const settingsWithCredential = await call(ctx.base, "GET", `/organizations/${fixtures.orgC.id}/settings`, { token: fixtures.orgC.ownerToken });
  assert.equal(settingsWithCredential.status, 403);
  assert.equal(settingsWithCredential.error.code, "ENTITLEMENT_REQUIRED");
});

test("entitlement enabled (active NA_PISTA/BUSINESS subscription) permits Scheduling operations", async () => {
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken);
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 200);
});
