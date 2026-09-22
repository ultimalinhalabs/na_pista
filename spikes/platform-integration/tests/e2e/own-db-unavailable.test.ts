/**
 * F19 §19: "Database unavailable" (Na Pista's OWN database, not the
 * Platform's) must fail closed as 503, never leak as a raw 500 with
 * driver internals. See platform-unavailable.test.ts for why every
 * module touching config/env.ts is imported dynamically, after the
 * override, rather than statically.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import type { Fixtures } from "./helpers.js"; // type-only — erased at compile time, no runtime import

process.env.NA_PISTA_DATABASE_URL = "postgres://baduser:badpass@127.0.0.1:65535/nope";

let close: () => Promise<void>;
let base: string;
const fixturesPath = fileURLToPath(new URL("../../.fixtures/f19-fixtures.json", import.meta.url));
const fixtures: Fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

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

test("own DB unreachable: create fails 503, not 500 (no driver internals leaked)", async () => {
  const res = await fetch(`${base}/organizations/${fixtures.orgA.id}/products`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "should never persist" }),
  });
  const json = await res.json();
  assert.equal(res.status, 503);
  assert.equal(json.error.code, "UPSTREAM_UNAVAILABLE");
  assert.ok(!JSON.stringify(json).includes("baduser"), "connection string must never leak into the response");
});
