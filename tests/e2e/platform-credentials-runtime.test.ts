/**
 * F29A — the proof that G1 is solved, against REAL infrastructure (no mocks):
 *
 *   START Na Pista (a real `src/server.ts` process)
 *   ↓ NO in-memory credential registration anywhere
 *   ↓ a real organization, its credential persisted (encrypted) in PostgreSQL
 *   ↓ real inbound request → real Platform introspection → persisted
 *     credential resolved + decrypted → real Platform entitlement call
 *   ✓ success — and still success after a RESTART
 *   ✗ fail closed once the credential is revoked
 *
 * Uses the F20 fixture organization A (real UL Platform organization with an
 * active NA_PISTA subscription) and its two real Platform-minted keys from
 * the git-ignored .fixtures/f20-fixtures.json: the platform-facing key is the
 * one provisioned into Na Pista's DB; the integration key authenticates the
 * inbound calls (service-to-service, so no expiring user session is needed).
 * Nothing new is minted on the Platform. Secrets never reach stdout: the test
 * asserts they are absent from every response and from the server's output.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { organizationPlatformCredentials } from "../../src/db/schema/index.js";
import { provisionPlatformCredential, revokePlatformCredential } from "../../src/modules/platformCredentials/service.js";
import { registeredServiceCredentialCount } from "../../src/platform/serviceAuth.js";

interface F20 {
  orgA: { id: string };
  apiKeys: Record<"platformFacingA" | "integrationA", { keyId: string; secret: string }>;
}
const fixtures: F20 = JSON.parse(readFileSync(fileURLToPath(new URL("../../.fixtures/f20-fixtures.json", import.meta.url)), "utf8"));
const orgId = fixtures.orgA.id;
const platformFacing = fixtures.apiKeys.platformFacingA;
const integration = fixtures.apiKeys.integrationA;
const actor = { type: "service" as const, id: "test:f29a-e2e" };
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

let server: { child: ChildProcess; base: string; output: () => string } | undefined;
const allServerOutput: string[] = [];
const allResponses: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

/** A real, separate Na Pista process — its own module graph, so its in-memory registry is empty by construction. */
async function startServer() {
  const port = await freePort();
  const chunks: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => chunks.push(String(d)));
  child.stderr!.on("data", (d) => chunks.push(String(d)));
  const base = `http://127.0.0.1:${port}/v1`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { child, base, output: () => chunks.join("") };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("Na Pista server did not start");
}

async function stopServer() {
  if (!server) return;
  const { child, output } = server;
  allServerOutput.push(output());
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill();
  });
  server = undefined;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${server!.base}/organizations/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${integration.secret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  allResponses.push(text);
  return { status: res.status, json: JSON.parse(text) as { data?: unknown; error?: { code: string } } };
}

before(async () => {
  const existing = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, orgId));
  assert.equal(existing.length, 0, `organization ${orgId} already has a persisted credential row — refusing to run against state this test does not own`);
});

after(async () => {
  await stopServer();
  // Remove only what this test created, so the F20–F28 suites (which inject
  // this organization's credential through the test override) are unaffected.
  await db.delete(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, orgId));
  // Bounded: an unbounded end() waited ~70s on the remote pooler's idle connections.
  await queryClient.end({ timeout: 5 });
});

test("provision: the real Platform introspects the key; only the encrypted form is stored", async () => {
  const result = await provisionPlatformCredential({ organizationId: orgId, credential: platformFacing.secret }, { actor, requestId: "f29a-e2e" });
  assert.equal(result.outcome, "PROVISIONED");

  const [row] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, orgId));
  assert.equal(row!.platformApiKeyId, platformFacing.keyId, "the Platform's own key id was recorded");
  assert.ok(!row!.encryptedCredential.includes(platformFacing.secret));
});

test("runtime: a started server with NO in-memory registration serves the organization (G1 solved)", async () => {
  assert.equal(registeredServiceCredentialCount(), 0, "this test process never registered a credential in memory");
  server = await startServer();

  const list = await call("GET", "/products?limit=5");
  assert.equal(list.status, 200, `expected 200, got ${list.status} ${list.json.error?.code ?? ""}`);
  assert.ok(Array.isArray(list.json.data) || typeof list.json.data === "object");

  // A write: entitlement check + Na Pista DB + usage write to the Platform, all with the persisted credential.
  const created = await call("POST", "/products", { name: `F29A runtime proof ${new Date().toISOString()}`, unit: "UNIT" });
  assert.equal(created.status, 201, `expected 201, got ${created.status} ${created.json.error?.code ?? ""}`);
  await new Promise((r) => setTimeout(r, 500));
  const out = server.output();
  assert.ok(!out.includes("usage.write.skipped_no_credential"), "usage was written with the persisted credential");
  assert.ok(!out.includes("usage.write.failed"), "the Platform accepted the usage write");
  assert.ok(!out.includes("platform_credential.unavailable"));
});

test("restart: a brand-new server process still serves the organization from PostgreSQL", async () => {
  await stopServer();
  server = await startServer();
  const list = await call("GET", "/products?limit=1");
  assert.equal(list.status, 200, `expected 200 after restart, got ${list.status} ${list.json.error?.code ?? ""}`);
});

test("revocation: once revoked, the server fails closed — 503, no Platform request with that credential", async () => {
  await revokePlatformCredential(orgId, { actor, reason: "f29a-e2e" });
  // Fresh process so no cached entitlement decision (10s TTL, OD-13) masks the revocation.
  await stopServer();
  server = await startServer();
  const list = await call("GET", "/products?limit=1");
  assert.equal(list.status, 503);
  assert.equal(list.json.error?.code, "UPSTREAM_UNAVAILABLE");
  assert.ok(server.output().includes('"reason":"REVOKED"'), "the server logged why (reason code only)");
});

test("no secret appears in any response or in the server's output", async () => {
  await stopServer();
  const [row] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, orgId));
  const everything = [...allResponses, ...allServerOutput].join("\n");
  assert.ok(everything.length > 0);
  for (const [label, value] of [
    ["platform-facing credential", platformFacing.secret],
    ["integration credential", integration.secret],
    ["ciphertext", row!.encryptedCredential],
    ["encryption key", process.env.NA_PISTA_CREDENTIAL_ENCRYPTION_KEY ?? "<unset>"],
  ] as const) {
    assert.ok(!everything.includes(value), `${label} must never appear in responses or logs`);
  }
});
