import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadFixtures, registerFixtureCredentials, startSpike } from "./helpers.js";

/**
 * F19 §1.1/§22: "Na Pista consegue autenticar utilizadores através do
 * ecossistema UL" — proved against the REAL, already-running UL Platform
 * (real HTTP, real database), not a mock.
 */
let ctx: Awaited<ReturnType<typeof startSpike>>;
const fixtures = loadFixtures();
const path = `/organizations/${fixtures.orgA.id}/products`;

before(async () => {
  ctx = await startSpike();
  registerFixtureCredentials(fixtures);
});
after(() => ctx.close());

test("no Authorization header -> 401", async () => {
  const res = await call(ctx.base, "GET", path);
  assert.equal(res.status, 401);
  assert.equal(res.error.code, "UNAUTHORIZED");
});

test("garbage bearer token -> 401 (rejected locally, not even shaped like a JWT or ulk_ key)", async () => {
  const res = await call(ctx.base, "GET", path, { token: "not-a-real-token" });
  assert.equal(res.status, 401);
});

test("structurally valid but obviously-expired JWT -> 401 via the local fast path (no Platform round trip needed to reject it)", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "00000000-0000-0000-0000-000000000000", exp: 1 })).toString("base64url");
  const fakeToken = `${header}.${payload}.deadbeef`; // signature is never checked locally — see ADR-012
  const res = await call(ctx.base, "GET", path, { token: fakeToken });
  assert.equal(res.status, 401);
});

test("valid human bearer token (Platform-issued) -> authentication succeeds (not a 401)", async () => {
  const res = await call(ctx.base, "GET", path, { token: fixtures.orgA.ownerToken });
  assert.notEqual(res.status, 401);
});

test("valid service credential (ulk_...) -> authentication succeeds (not a 401)", async () => {
  const res = await call(ctx.base, "GET", path, { token: fixtures.apiKeys.integrationA.secret });
  assert.notEqual(res.status, 401);
});

test("unknown service credential shape (ulk_ prefix, garbage body) -> 401", async () => {
  const res = await call(ctx.base, "GET", path, { token: "ulk_00000000-0000-0000-0000-000000000000.garbage" });
  assert.equal(res.status, 401);
});
