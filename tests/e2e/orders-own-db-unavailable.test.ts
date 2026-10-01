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

import { startChildServer } from "./childServer.js";

let close: () => Promise<void>;
let base: string;
const fixturesPath = fileURLToPath(new URL("../../.fixtures/f23-fixtures.json", import.meta.url));
const fixtures: F23Fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

/**
 * F29A: the server runs out of process (tests/e2e/childServer.ts) with its
 * own database pointed at an unreachable address. Since F29A the
 * organization's Platform credential lives in that same database, so the
 * request now fails closed one step earlier — at credential resolution
 * (STORE_UNAVAILABLE) instead of at the repository — with the same
 * outward contract asserted below: 503 UPSTREAM_UNAVAILABLE, no bypass, no
 * leaked connection details. Running in-process made Windows' forced test
 * exit race the dead-database socket teardown (native libuv assertion)
 * after the assertion had already passed; see childServer.ts.
 */
before(async () => {
  const server = await startChildServer({ NA_PISTA_DATABASE_URL: "postgres://baduser:badpass@127.0.0.1:65535/nope" });
  base = server.base;
  close = server.close;
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
