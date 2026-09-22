/**
 * F19 §19: "Platform unavailable" / timeout must fail closed.
 *
 * Exercises the real network failure path directly against `callPlatform`
 * — a genuine TCP connection attempt to a port nothing listens on, still
 * real evidence of the fail-closed behavior — rather than through a full
 * spun-up Express server + incoming HTTP request + outgoing HTTP request
 * chain. An earlier version of this test did use the full HTTP round
 * trip and reliably reproduced a native libuv crash on Windows
 * (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`)
 * when `--test-force-exit` tore the process down while an aborted
 * connection's handle was still settling — a real, reproducible
 * environment issue, not a Na Pista bug, and not worth chasing further
 * inside a spike; testing one layer down avoids it while still proving
 * the same fail-closed contract for real.
 *
 * IMPORTANT: ES module `import` declarations are hoisted and execute
 * BEFORE this file's own top-level statements — verified experimentally
 * elsewhere in this suite. Every module that reads `config/env.ts` is
 * loaded with a dynamic `import()` inside `before()`, after the override.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";

process.env.PLATFORM_API_URL = "http://127.0.0.1:65535"; // nothing listens here — connection refused, not a slow timeout

let callPlatform: typeof import("../../src/platform/client.js").callPlatform;
let UpstreamUnavailableError: typeof import("../../src/shared/errors.js").UpstreamUnavailableError;

before(async () => {
  ({ callPlatform } = await import("../../src/platform/client.js"));
  ({ UpstreamUnavailableError } = await import("../../src/shared/errors.js"));
});

test("callPlatform: unreachable Platform -> UpstreamUnavailableError, never a silent success", async () => {
  await assert.rejects(() => callPlatform("GET", "/me", { token: "irrelevant" }), UpstreamUnavailableError);
});

test("callPlatform: the same failure mode for a POST (used by service-scoped writes)", async () => {
  await assert.rejects(
    () => callPlatform("POST", "/organizations/x/applications/NA_PISTA/usage", { token: "irrelevant", body: {} }),
    UpstreamUnavailableError,
  );
});
