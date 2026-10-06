import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { auditEvents, organizationPlatformCredentials } from "../../src/db/schema/index.js";
import {
  invalidatePlatformCredentialCache,
  PlatformCredentialUnavailableError,
  resolvePlatformCredential,
} from "../../src/modules/platformCredentials/resolver.js";
import {
  getPlatformCredentialStatus,
  provisionPlatformCredential,
  revokePlatformCredential,
  type IdentifyCredential,
} from "../../src/modules/platformCredentials/service.js";
import { clearServiceCredentials, registerServiceCredential } from "../../src/platform/serviceAuth.js";
import { parseEncryptionKey } from "../../src/security/credentialCrypto.js";
import { ConflictError, ValidationError } from "../../src/shared/errors.js";

/**
 * F29A integration: real PostgreSQL (the configured Na Pista database),
 * repository + resolver + provisioning service, no HTTP. Platform
 * introspection is replaced by a stub that states which organization a
 * test credential belongs to — the real Platform is exercised end to end in
 * tests/e2e/platform-credentials-runtime.test.ts. Every organization id,
 * key and credential here is generated per run; rows are removed at the end.
 */
const testKey = randomBytes(32);
const key = () => testKey;
const actor = { type: "service" as const, id: "test:f29a-integration" };
const orgIds: string[] = [];

function newOrg() {
  const id = randomUUID();
  orgIds.push(id);
  return id;
}

/** A credential string shaped like a Platform key, and a stub that attributes it to `organizationId`. */
function credentialFor(organizationId: string, application = "NA_PISTA") {
  const apiKeyId: string = randomUUID();
  const credential = `ulk_${apiKeyId}.${randomBytes(24).toString("base64url")}`;
  const identify: IdentifyCredential = async () => ({ apiKeyId, application, organizationId });
  return { apiKeyId, credential, identify };
}

async function provision(organizationId: string, c = credentialFor(organizationId), extra: { replaceActive?: boolean } = {}) {
  const result = await provisionPlatformCredential({ organizationId, credential: c.credential }, { actor, identify: c.identify, key, ...extra });
  return { ...c, result };
}

async function rejectsUnavailable(promise: Promise<unknown>, reason: string) {
  await assert.rejects(promise, (e: unknown) => e instanceof PlatformCredentialUnavailableError && e.reason === reason && e.statusCode === 503);
}

after(async () => {
  clearServiceCredentials();
  if (orgIds.length) await db.delete(organizationPlatformCredentials).where(inArray(organizationPlatformCredentials.organizationId, orgIds));
  await queryClient.end();
});

test("persistence + retrieval: the stored row is encrypted; the resolver returns the original credential", async () => {
  const org = newOrg();
  const { credential, apiKeyId, result } = await provision(org);
  assert.equal(result.outcome, "PROVISIONED");
  assert.equal(result.status.status, "ACTIVE");
  assert.ok(!("encryptedCredential" in result.status), "status metadata never carries the ciphertext");

  const [row] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));
  assert.ok(row);
  assert.equal(row.platformApiKeyId, apiKeyId);
  assert.ok(row.encryptedCredential.startsWith("v1:"));
  assert.ok(!row.encryptedCredential.includes(credential), "plaintext is never stored");

  assert.equal(await resolvePlatformCredential(org, { key }), credential);
});

test("missing credential fails closed (503), and an invalid organization id is rejected before any lookup", async () => {
  await rejectsUnavailable(resolvePlatformCredential(newOrg(), { key }), "NOT_PROVISIONED");
  await rejectsUnavailable(resolvePlatformCredential("not-a-uuid", { key }), "INVALID_ORGANIZATION");
});

test("revocation: a revoked credential fails closed and cannot be bypassed by the test override", async () => {
  const org = newOrg();
  const { credential } = await provision(org);
  const status = await revokePlatformCredential(org, { actor });
  assert.equal(status.status, "REVOKED");
  assert.ok(status.revokedAt);

  await rejectsUnavailable(resolvePlatformCredential(org, { key }), "REVOKED");
  registerServiceCredential(org, credential); // non-production override present…
  await rejectsUnavailable(resolvePlatformCredential(org, { key }), "REVOKED"); // …and still ignored: the DB row wins
  clearServiceCredentials();
});

test("a revoked credential is never silently reactivated by re-provisioning it", async () => {
  const org = newOrg();
  const c = credentialFor(org);
  await provision(org, c);
  await revokePlatformCredential(org, { actor });
  await assert.rejects(provision(org, c), ConflictError);
  await rejectsUnavailable(resolvePlatformCredential(org, { key }), "REVOKED");
});

test("tenant isolation: A resolves A, B resolves B, neither resolves the other", async () => {
  const orgA = newOrg();
  const orgB = newOrg();
  const a = await provision(orgA);
  const b = await provision(orgB);

  const resolvedA = await resolvePlatformCredential(orgA, { key });
  const resolvedB = await resolvePlatformCredential(orgB, { key });
  assert.equal(resolvedA, a.credential);
  assert.equal(resolvedB, b.credential);
  assert.notEqual(resolvedA, b.credential);
  assert.notEqual(resolvedB, a.credential);
});

test("tenant isolation at rest: B's ciphertext copied into A's row does not decrypt (AAD binding)", async () => {
  const orgA = newOrg();
  const orgB = newOrg();
  await provision(orgA);
  await provision(orgB);
  const [rowB] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, orgB));
  await db
    .update(organizationPlatformCredentials)
    .set({ encryptedCredential: rowB!.encryptedCredential })
    .where(eq(organizationPlatformCredentials.organizationId, orgA));

  await rejectsUnavailable(resolvePlatformCredential(orgA, { key }), "DECRYPTION_FAILED");
});

test("provisioning refuses a credential that belongs to another organization or another application", async () => {
  const org = newOrg();
  const other = newOrg();
  await assert.rejects(provision(org, credentialFor(other)), ValidationError);
  await assert.rejects(provision(org, credentialFor(org, "FOI")), ValidationError);
  assert.equal((await getPlatformCredentialStatus(org)).configured, false);
});

test("idempotent: re-provisioning the same key is a no-op; a different key is refused without overwriting", async () => {
  const org = newOrg();
  const first = await provision(org);
  const again = await provision(org, first);
  assert.equal(again.result.outcome, "UNCHANGED");

  await assert.rejects(provision(org), ConflictError);
  assert.equal(await resolvePlatformCredential(org, { key }), first.credential, "the active credential was not overwritten");
  const rows = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));
  assert.equal(rows.length, 1);
});

test("the database itself refuses a second ACTIVE credential for one organization", async () => {
  const org = newOrg();
  await provision(org);
  const [row] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));
  await assert.rejects(
    db.insert(organizationPlatformCredentials).values({
      organizationId: org,
      platformApiKeyId: randomUUID(),
      encryptedCredential: row!.encryptedCredential,
      status: "ACTIVE",
    }),
  );
});

test("explicit rotation (replaceActive) revokes the old credential and activates the new one atomically", async () => {
  const org = newOrg();
  const oldCred = await provision(org);
  const newCred = await provision(org, credentialFor(org), { replaceActive: true });
  assert.equal(newCred.result.outcome, "ROTATED");
  assert.equal(await resolvePlatformCredential(org, { key }), newCred.credential);

  const rows = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.platformApiKeyId === oldCred.apiKeyId)?.status, "REVOKED");
  assert.equal(rows.find((r) => r.platformApiKeyId === newCred.apiKeyId)?.status, "ACTIVE");
});

test("missing encryption key fails closed on both provisioning and resolution", async () => {
  const org = newOrg();
  const noKey = () => parseEncryptionKey(undefined);
  const c = credentialFor(org);
  await assert.rejects(provisionPlatformCredential({ organizationId: org, credential: c.credential }, { actor, identify: c.identify, key: noKey }));
  assert.equal((await getPlatformCredentialStatus(org)).configured, false, "nothing is written without a key");

  await provision(org, c);
  await rejectsUnavailable(resolvePlatformCredential(org, { key: noKey }), "KEY_MISSING");
  await rejectsUnavailable(resolvePlatformCredential(org, { key: () => randomBytes(32) }), "DECRYPTION_FAILED");
});

test("concurrent resolution returns the same credential every time", async () => {
  const org = newOrg();
  const { credential } = await provision(org);
  const results = await Promise.all(Array.from({ length: 20 }, () => resolvePlatformCredential(org, { key })));
  assert.ok(results.every((r) => r === credential));
});

test("concurrent provisioning: same key → one row; different keys → exactly one wins", async () => {
  const org = newOrg();
  const c = credentialFor(org);
  const same = await Promise.allSettled([provision(org, c), provision(org, c), provision(org, c)]);
  assert.ok(same.every((r) => r.status === "fulfilled"), "provisioning the same key concurrently never errors");
  const sameRows = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));
  assert.equal(sameRows.length, 1);

  const org2 = newOrg();
  const race = await Promise.allSettled([provision(org2), provision(org2), provision(org2)]);
  assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(race.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof ConflictError));
  const activeRows = await db
    .select()
    .from(organizationPlatformCredentials)
    .where(and(eq(organizationPlatformCredentials.organizationId, org2), eq(organizationPlatformCredentials.status, "ACTIVE")));
  assert.equal(activeRows.length, 1);
});

test("audit: provisioning and revocation are recorded with metadata only — never the credential or ciphertext", async () => {
  const org = newOrg();
  const { credential, apiKeyId } = await provision(org);
  await revokePlatformCredential(org, { actor });
  const [row] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));

  const events = await db.select().from(auditEvents).where(eq(auditEvents.organizationId, org));
  assert.deepEqual(events.map((e) => e.action).sort(), ["platform_credential.provisioned", "platform_credential.revoked"]);
  for (const event of events) {
    const text = JSON.stringify(event);
    assert.ok(!text.includes(credential));
    assert.ok(!text.includes(row!.encryptedCredential));
    assert.equal((event.metadata as { platformApiKeyId: string }).platformApiKeyId, apiKeyId);
    assert.equal(event.resourceType, "platform_credential");
  }
});

test("no secret reaches logs or error messages on any failure path", async () => {
  const org = newOrg();
  const { credential } = await provision(org);
  const [row] = await db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));

  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  const errors: string[] = [];
  try {
    // Thunks, started one at a time — so every rejection is handled as it happens.
    const attempts: (() => Promise<unknown>)[] = [
      () => resolvePlatformCredential(org, { key: () => randomBytes(32) }),
      () => resolvePlatformCredential(org, { key: () => parseEncryptionKey(undefined) }),
      () => revokePlatformCredential(org, { actor }).then(() => resolvePlatformCredential(org, { key })),
      () =>
        provision(org, {
          credential,
          apiKeyId: row!.platformApiKeyId,
          identify: async () => ({ apiKeyId: row!.platformApiKeyId, application: "NA_PISTA", organizationId: org }),
        }),
    ];
    for (const attempt of attempts) {
      await attempt().catch((e: Error) => errors.push(`${e.message} ${e.stack ?? ""}`));
    }
  } finally {
    console.log = original;
  }

  const everything = [...lines, ...errors].join("\n");
  assert.ok(errors.length >= 3);
  assert.ok(!everything.includes(credential), "plaintext credential never logged or in an error");
  assert.ok(!everything.includes(row!.encryptedCredential), "ciphertext never logged or in an error");
  assert.ok(!everything.includes(testKey.toString("base64")), "key never logged or in an error");
});

test("row cache: a revocation made by another process is enforced once the cached row expires (≤10s, OD-13 window)", async () => {
  const org = newOrg();
  const { credential } = await provision(org);
  assert.equal(await resolvePlatformCredential(org, { key }), credential); // row now cached

  // Another process revokes directly in the database (this process's cache is not told).
  await db
    .update(organizationPlatformCredentials)
    .set({ status: "REVOKED", revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(organizationPlatformCredentials.organizationId, org));
  assert.equal(await resolvePlatformCredential(org, { key }), credential, "within the TTL the cached row still applies");

  invalidatePlatformCredentialCache(org); // = TTL elapsed
  await rejectsUnavailable(resolvePlatformCredential(org, { key }), "REVOKED");
});

test("row cache: a cached miss is invalidated by in-process provisioning — the new credential is usable immediately", async () => {
  const org = newOrg();
  await rejectsUnavailable(resolvePlatformCredential(org, { key }), "NOT_PROVISIONED"); // "no row" now cached
  const { credential } = await provision(org); // invalidates
  assert.equal(await resolvePlatformCredential(org, { key }), credential);
});

test("restart simulation: a fresh process (new module graph, empty registry) resolves the persisted credential", async () => {
  const org = newOrg();
  const { credential } = await provision(org);
  clearServiceCredentials();

  const script = fileURLToPath(new URL("./support/resolveInFreshProcess.ts", import.meta.url));
  // The child prints only a SHA-256 of what it resolved — the credential never crosses stdout.
  const out = execFileSync(process.execPath, ["--import", "tsx", script, org], {
    env: { ...process.env, NA_PISTA_CREDENTIAL_ENCRYPTION_KEY: testKey.toString("base64") },
    encoding: "utf8",
  });
  const result = JSON.parse(out.trim().split("\n").pop()!) as { registered: number; sha256: string };
  assert.equal(result.registered, 0, "the fresh process registered nothing in memory");
  assert.equal(result.sha256, createHash("sha256").update(credential).digest("hex"));
});
