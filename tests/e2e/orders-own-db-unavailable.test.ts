/**
 * F23 brief §41 E2E item 33: Na Pista's own database unreachable -> 503,
 * never a bypass, never a leaked driver error, never a partial Order.
 * Same technique as F19/F20/F21's own-db-unavailable tests — proves
 * Orders' own wiring into the SAME, unchanged errorHandler mapping
 * (shared/errors.ts `isConnectionError` + `middleware/errorHandler.ts`).
 * Transactional atomicity under a forced failure is proven more directly
 * in `tests/integration/orders.test.ts` (item 19, a real audit-insert
 * failure inside the confirmation transaction) — this test is the
 * API-boundary complement: the outward-facing contract when the database
 * itself cannot be reached at all.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import type { F23Fixtures } from "./ordersHelpers.js"; // type-only — erased at compile time

process.env.NA_PISTA_DATABASE_URL = "postgres://baduser:badpass@127.0.0.1:65535/nope";

let close: () => Promise<void>;
let base: string;
const fixturesPath = fileURLToPath(new URL("../../.fixtures/f23-fixtures.json", import.meta.url));
const fixtures: F23Fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

before(async () => {
  const { buildApp } = await import("../../src/app.js");
  const { registerServiceCredential } = await import("../../src/platform/serviceAuth.js");
  // Real Platform, real credential — auth, tenant resolution and the
  // entitlement check all succeed; only the repository's own DB call fails.
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);

  const app = buildApp();
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  base = `http://127.0.0.1:${address.port}/v1`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
after(() => close());

test("own DB unreachable: Order creation fails 503, not 500, and never bypasses to a successful create", async () => {
  const res = await fetch(`${base}/organizations/${fixtures.orgA.id}/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ items: [] }),
  });
  const json = await res.json();
  assert.equal(res.status, 503);
  assert.equal(json.error.code, "UPSTREAM_UNAVAILABLE");
  assert.ok(!JSON.stringify(json).includes("baduser"), "connection string must never leak into the response");
});
