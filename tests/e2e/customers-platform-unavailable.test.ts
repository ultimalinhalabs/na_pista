/**
 * F21 brief §19/§20 matrix item 23: Platform unavailable -> fail closed.
 * Same technique as F19/F20 (tested directly against `callPlatform`, not
 * through a full HTTP round trip — see na-pista's F19 spike docs for why:
 * a reproducible native libuv crash on Windows was avoided this way).
 * ES module `import` is hoisted — every module reading `config/env.ts`
 * is loaded dynamically, after the override, never statically.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";

process.env.PLATFORM_API_URL = "http://127.0.0.1:65535"; // nothing listens here

let callPlatform: typeof import("../../src/platform/client.js").callPlatform;
let UpstreamUnavailableError: typeof import("../../src/shared/errors.js").UpstreamUnavailableError;

before(async () => {
  ({ callPlatform } = await import("../../src/platform/client.js"));
  ({ UpstreamUnavailableError } = await import("../../src/shared/errors.js"));
});

test("callPlatform: unreachable Platform -> UpstreamUnavailableError, never a silent success", async () => {
  await assert.rejects(() => callPlatform("GET", "/me", { token: "irrelevant" }), UpstreamUnavailableError);
});
