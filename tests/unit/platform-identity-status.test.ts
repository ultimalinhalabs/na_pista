import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, mock } from "node:test";
import type { Request, Response } from "express";

/**
 * Fase 6 (UL Platform) — Na Pista reads identity, organization, membership,
 * role and application access from the Platform (GET /v1/me, GET
 * /v1/service/me) and never keeps a parallel authority. The Platform is
 * simulated by a local HTTP server; no request leaves the machine and no
 * database is touched.
 */

type Me = { status: number; body: unknown };
const responses = new Map<string, Me>();
let hits = 0;
const platform = http.createServer((req, res) => {
  hits++;
  const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const r = responses.get(`${req.url?.endsWith("/service/me") ? "svc" : "me"}:${token}`);
  res.statusCode = r?.status ?? 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(r?.body ?? { error: { code: "UNAUTHORIZED", message: "x" } }));
});

let mod: typeof import("../../src/platform/membership.js");
let svc: typeof import("../../src/platform/serviceIntrospection.js");
let tenant: typeof import("../../src/tenancy/tenantContext.js");
let envMod: typeof import("../../src/config/env.js");

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function membership(organizationId: string, extra: Record<string, unknown> = {}) {
  return { membershipId: `m-${organizationId}`, organizationId, organizationName: "Org", roleKey: "STAFF", status: "active", ...extra };
}
function me(token: string, memberships: unknown[], extra: Record<string, unknown> = {}) {
  responses.set(`me:${token}`, { status: 200, body: { data: { userId: `u-${token}`, email: "x@test.invalid", memberships, ...extra } } });
}

async function tenantFor(token: string, organizationId: string) {
  const identity = await mod.resolveIdentity(token);
  const req = { params: { organizationId }, auth: { userId: identity.userId }, identity } as unknown as Request;
  let error: { statusCode?: number; code?: string } | undefined;
  tenant.requireTenantContext()(req, {} as Response, (err?: unknown) => {
    error = err as typeof error;
  });
  return { tenant: req.tenant, error };
}

before(async () => {
  await new Promise<void>((r) => platform.listen(0, "127.0.0.1", () => r()));
  process.env.DOTENV_CONFIG_PATH = "/nonexistent/.env";
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/v1`;
  process.env.NA_PISTA_DATABASE_URL = "postgres://unused@127.0.0.1:1/unused";
  envMod = await import("../../src/config/env.js");
  mod = await import("../../src/platform/membership.js");
  svc = await import("../../src/platform/serviceIntrospection.js");
  tenant = await import("../../src/tenancy/tenantContext.js");
});

after(() => {
  platform.close();
});

test("active user + active organization + active membership → tenant with the organization role", async () => {
  me("active", [membership(ORG_A, { organization: { id: ORG_A, name: "A", slug: "a", status: "active" } })], { status: "active" });
  const r = await tenantFor("active", ORG_A);
  assert.equal(r.error, undefined);
  assert.equal(r.tenant?.roleKey, "STAFF");
  assert.equal(r.tenant?.actorType, "human");
});

test("disabled user → ACCOUNT_DISABLED (403 from the Platform, or status in the body)", async () => {
  responses.set("me:disabled", { status: 403, body: { error: { code: "ACCOUNT_DISABLED", message: "disabled" } } });
  await assert.rejects(() => mod.resolveIdentity("disabled"), (e: { code?: string; statusCode?: number }) => e.code === "ACCOUNT_DISABLED" && e.statusCode === 403);
  me("disabled-body", [membership(ORG_A)], { status: "disabled" });
  await assert.rejects(() => mod.resolveIdentity("disabled-body"), (e: { code?: string }) => e.code === "ACCOUNT_DISABLED");
});

test("invalid/expired token → 401", async () => {
  await assert.rejects(() => mod.resolveIdentity("nope"), (e: { statusCode?: number }) => e.statusCode === 401);
});

test("suspended organization → ORGANIZATION_SUSPENDED; another active organization of the same user keeps working", async () => {
  me("susp", [
    membership(ORG_A, { organization: { id: ORG_A, name: "A", slug: "a", status: "suspended" } }),
    membership(ORG_B, { organization: { id: ORG_B, name: "B", slug: "b", status: "active" } }),
  ]);
  const a = await tenantFor("susp", ORG_A);
  assert.equal(a.error?.code, "ORGANIZATION_SUSPENDED");
  assert.equal(a.error?.statusCode, 403);
  assert.equal((await tenantFor("susp", ORG_B)).error, undefined);
});

test("suspended membership, unknown organization and cross-organization access → 403", async () => {
  me("memb", [membership(ORG_A, { status: "suspended" })]);
  assert.equal((await tenantFor("memb", ORG_A)).error?.statusCode, 403, "suspended membership");
  me("cross", [membership(ORG_A)]);
  assert.equal((await tenantFor("cross", ORG_B)).error?.statusCode, 403, "member of A asking for B");
  assert.equal((await tenantFor("cross", "33333333-3333-4333-8333-333333333333")).error?.statusCode, 403, "unknown organization");
});

test("a Platform that does not send the Fase 6 fields yet keeps working (backward compatible)", async () => {
  me("legacy", [membership(ORG_A)]);
  const r = await tenantFor("legacy", ORG_A);
  assert.equal(r.error, undefined);
  assert.equal(r.tenant?.roleKey, "STAFF");
});

test("application role: the NA_PISTA role reported by the Platform is the role Na Pista authorizes with", async () => {
  me("approle", [membership(ORG_A, { roleKey: "STAFF", applications: [{ key: "NA_PISTA", roleKey: "ADMIN", roleSource: "explicit" }] })]);
  assert.equal((await tenantFor("approle", ORG_A)).tenant?.roleKey, "ADMIN");
  me("approle-other", [membership(ORG_A, { roleKey: "MANAGER", applications: [{ key: "QUALE_A_DICA", roleKey: "AGENT", roleSource: "fallback" }] })]);
  assert.equal((await tenantFor("approle-other", ORG_A)).tenant?.roleKey, "MANAGER", "another application's role is ignored");
});

test("application access: off by default (no behaviour change); when enforced, valid access passes and revoked/absent access is refused", async () => {
  me("access-none", [membership(ORG_A, { applications: [] })]);
  me("access-ok", [membership(ORG_A, { applications: [{ key: "NA_PISTA", roleKey: "STAFF", roleSource: "fallback" }] })]);
  assert.equal(envMod.env.NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS, "false");
  assert.equal((await tenantFor("access-none", ORG_A)).error, undefined, "enforcement off → unchanged");

  Object.assign(envMod.env, { NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS: "true" });
  try {
    assert.equal((await tenantFor("access-ok", ORG_A)).error, undefined, "valid application access");
    const refused = await tenantFor("access-none", ORG_A);
    assert.equal(refused.error?.code, "APPLICATION_ACCESS_REQUIRED", "revoked/absent access");
    assert.equal(refused.error?.statusCode, 403);
  } finally {
    Object.assign(envMod.env, { NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS: "false" });
  }
});

test("identity cache: 15 s — one Platform call inside the window; a revocation is visible after the window, never later", async () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    me("cache", [membership(ORG_A)]);
    mod._clearMembershipCache();
    const before = hits;
    await mod.resolveIdentity("cache");
    await mod.resolveIdentity("cache");
    assert.equal(hits - before, 1, "cached within the window");

    me("cache", [membership(ORG_A, { status: "suspended" })]); // revoked on the Platform
    mock.timers.tick(mod.IDENTITY_CACHE_TTL_MS - 1);
    assert.equal((await tenantFor("cache", ORG_A)).error, undefined, "still the cached (active) view inside the window");
    mock.timers.tick(2);
    assert.equal((await tenantFor("cache", ORG_A)).error?.statusCode, 403, "revocation applied once the window expires");
    assert.equal(mod.IDENTITY_CACHE_TTL_MS, 15_000);
  } finally {
    mock.timers.reset();
  }
});

test("service-to-service: valid key resolves; a key of a suspended organization → ORGANIZATION_SUSPENDED; scoped to its own organization", async () => {
  responses.set("svc:ulk_ok", { status: 200, body: { data: { apiKeyId: "k1", application: "QUALE_A_DICA", organizationId: ORG_A, scopes: ["catalog.read"] } } });
  responses.set("svc:ulk_susp", { status: 403, body: { error: { code: "ORGANIZATION_SUSPENDED", message: "suspended" } } });
  svc._clearServiceIdentityCache();
  const identity = await svc.introspectServiceCredential("ulk_ok");
  assert.equal(identity.organizationId, ORG_A);
  await assert.rejects(() => svc.introspectServiceCredential("ulk_susp"), (e: { code?: string }) => e.code === "ORGANIZATION_SUSPENDED");
  await assert.rejects(() => svc.introspectServiceCredential("ulk_revoked"), (e: { statusCode?: number }) => e.statusCode === 401);

  const run = (organizationId: string) => {
    const req = { params: { organizationId }, service: identity } as unknown as Request;
    let error: { statusCode?: number } | undefined;
    tenant.requireTenantContext()(req, {} as Response, (err?: unknown) => {
      error = err as typeof error;
    });
    return { req, error };
  };
  assert.equal(run(ORG_A).error, undefined);
  assert.equal(run(ORG_B).error?.statusCode, 403, "a key never crosses into another organization");
});
