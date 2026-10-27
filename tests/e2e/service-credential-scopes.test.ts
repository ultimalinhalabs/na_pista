import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { env } from "../../src/config/env.js";
import { _clearServiceIdentityCache } from "../../src/platform/serviceIntrospection.js";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/**
 * Credentials audit 2026-10-23, live against the real (local) UL Platform: keys are minted by the organization's
 * OWNER through the UL API and introspected by the real Platform. Org A only (F20 fixtures).
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadFixtures();
const platformAdmin = (fixtures as unknown as { platformAdmin: { token: string } }).platformAdmin;
const orgA = fixtures.orgA.id;
const keys: Record<string, { id: string; secret: string }> = {};

async function ul(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${fixtures.platformBaseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: ((await res.json().catch(() => ({}))) as { data?: { id: string; secret: string } }).data };
}
async function mint(label: string, applicationKey: string, scopes: string[]) {
  const r = await ul("POST", `/organizations/${orgA}/api-keys`, fixtures.orgA.ownerToken, { applicationKey, scopes });
  assert.equal(r.status, 201, `${label}: ${applicationKey} [${scopes}]`);
  keys[label] = r.data!;
}
// ADR-073: service-credential creates carry an Idempotency-Key (a fresh one per call here).
const np = (label: string, method: string, path: string, body?: unknown) =>
  call(ctx.base, method, `/organizations/${orgA}${path}`, { token: keys[label]!.secret, body, headers: method === "POST" ? { "idempotency-key": randomUUID() } : {} });

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fixtures);
  assert.equal((await ul("PUT", `/platform/organizations/${orgA}/applications/QUALE_A_DICA/access`, platformAdmin.token)).status, 200);
  await mint("qd", "QUALE_A_DICA", ["catalog.read"]);
  await mint("customerRead", "NA_PISTA", ["customer.read"]);
  await mint("customerWrite", "NA_PISTA", ["customer.write"]);
  await mint("legacyRead", "NA_PISTA", ["catalog.read"]);
});
after(() => ctx.close());

test("a QUALE_A_DICA key with catalog.read is refused on every Na Pista route of its own organization", async () => {
  for (const path of ["/products", "/customers", "/orders", "/inventory"]) {
    const r = await np("qd", "GET", path);
    assert.equal(r.status, 403, path);
    assert.equal(r.error.code, "FORBIDDEN");
  }
});

test("customer.read reads customers and nothing else; customer.write writes them; read never writes", async () => {
  assert.equal((await np("customerRead", "GET", "/customers")).status, 200);
  assert.equal((await np("customerRead", "GET", "/products")).status, 403, "no catalog");
  assert.equal((await np("customerRead", "GET", "/orders")).status, 403, "no orders");
  assert.equal((await np("customerRead", "POST", "/customers", { name: "Cliente Fictício" })).status, 403, "read never writes");
  assert.equal((await np("customerWrite", "POST", "/customers", { name: "Cliente Fictício" })).status, 201);
  assert.equal((await np("customerWrite", "GET", "/customers")).status, 403, "write is not read");
});

test("transition: a NA_PISTA key holding only catalog.read reaches customers while legacy=accept, not when legacy=refuse; catalog itself unaffected", async () => {
  const mutable = env as { NA_PISTA_LEGACY_CATALOG_SCOPES: "accept" | "refuse" };
  const previous = mutable.NA_PISTA_LEGACY_CATALOG_SCOPES;
  try {
    mutable.NA_PISTA_LEGACY_CATALOG_SCOPES = "accept";
    assert.equal((await np("legacyRead", "GET", "/customers")).status, 200);
    mutable.NA_PISTA_LEGACY_CATALOG_SCOPES = "refuse";
    assert.equal((await np("legacyRead", "GET", "/customers")).status, 403);
    assert.equal((await np("legacyRead", "GET", "/orders")).status, 403);
    assert.equal((await np("legacyRead", "GET", "/products")).status, 200, "catalog.read still reads the catalog");
  } finally {
    mutable.NA_PISTA_LEGACY_CATALOG_SCOPES = previous;
  }
});

test("organization isolation: org A's NA_PISTA key on org B's path → 403", async () => {
  const r = await call(ctx.base, "GET", `/organizations/${fixtures.orgB.id}/customers`, { token: keys.customerRead!.secret });
  assert.equal(r.status, 403);
});

test("no extra Platform call on the warm path: an authorized request and an other-application refusal make zero UL calls", async () => {
  await np("customerRead", "GET", "/customers");
  await np("qd", "GET", "/customers");
  const original = globalThis.fetch;
  let platformCalls = 0;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input instanceof Request ? input.url : input).startsWith(fixtures.platformBaseUrl)) platformCalls++;
    return original(input, init);
  }) as typeof fetch;
  try {
    // Requests to Na Pista itself go through the original fetch counted only when they target the Platform.
    assert.equal((await np("customerRead", "GET", "/customers")).status, 200);
    assert.equal((await np("qd", "GET", "/customers")).status, 403);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(platformCalls, 0, "identity and entitlements come from the existing short caches; the new checks are in memory");
});

test("revocation: a revoked NA_PISTA key is refused (401) once the identity cache no longer holds it", async () => {
  assert.equal((await ul("POST", `/organizations/${orgA}/api-keys/${keys.customerRead!.id}/revoke`, fixtures.orgA.ownerToken)).status, 200);
  _clearServiceIdentityCache(); // the documented ≤15 s window, skipped
  assert.equal((await np("customerRead", "GET", "/customers")).status, 401);
});
