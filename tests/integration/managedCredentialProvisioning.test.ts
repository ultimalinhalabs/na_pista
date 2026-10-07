import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";

/**
 * D2-B — Na Pista side of managed credential provisioning, on the real (local, guarded) Na Pista
 * database with F29A encryption, against a LOCAL simulated Platform that applies the Platform's
 * provisioning rules (issue count, PENDING, proof-of-possession confirm, CREDENTIAL_REVOKED).
 * Cross-repository code is never imported (CLAUDE.md §2): the real Platform is exercised by the
 * end-to-end run. No request leaves the machine; every credential is generated here.
 */

type Key = { id: string; token: string; org: string; pr: string; status: "PENDING" | "ACTIVE" | "REVOKED" };
type Req = { id: string; org: string; status: "REQUESTED" | "ISSUED" | "ACTIVE" | "CANCELLED" | "REVOKED"; issueCount: number; current: string | null };

const PROVISIONER = `ulk_${randomUUID()}.${randomBytes(16).toString("base64url")}`;
const requests = new Map<string, Req>();
const keys = new Map<string, Key>(); // token → key
const knobs = { dropConfirmResponse: 0, failConfirmUnprocessed: 0 };
const counters = { issue: 0, confirm: 0 };

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
const err = (res: http.ServerResponse, status: number, code: string) => send(res, status, { error: { code, message: code } });

const platform = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const url = req.url ?? "";
    const key = keys.get(token);
    if (url === "/v1/service/me") {
      if (!key) return err(res, 401, "UNAUTHORIZED");
      if (key.status === "REVOKED") return err(res, 401, "CREDENTIAL_REVOKED");
      return send(res, 200, { data: { apiKeyId: key.id, application: "NA_PISTA", organizationId: key.org, scopes: ["usage.write", "event.publish"], credentialClass: "INTEGRATION_MANAGED", purpose: "platform_integration", status: key.status, provisioningRequestId: key.pr } });
    }
    if (url === "/v1/service/credential-provisionings" && req.method === "GET") {
      if (token !== PROVISIONER) return err(res, 403, "FORBIDDEN");
      return send(res, 200, { data: [...requests.values()].filter((r) => r.status === "REQUESTED" || r.status === "ISSUED").map((r) => ({ id: r.id, organizationId: r.org, application: "NA_PISTA", status: r.status, issueCount: r.issueCount, currentCredentialId: r.current })) });
    }
    const issue = /^\/v1\/service\/credential-provisionings\/([^/]+)\/issue$/.exec(url);
    if (issue && req.method === "POST") {
      if (token !== PROVISIONER) return err(res, 403, "FORBIDDEN");
      const pr = requests.get(issue[1]!);
      if (!pr) return err(res, 404, "NOT_FOUND");
      const { expectedIssueCount } = JSON.parse(raw || "{}");
      if (pr.status !== "REQUESTED" && pr.status !== "ISSUED") return err(res, 409, "PROVISIONING_NOT_OPEN");
      if (pr.issueCount !== expectedIssueCount) return err(res, 409, "PROVISIONING_ISSUE_COUNT_MISMATCH");
      for (const k of keys.values()) if (k.pr === pr.id && k.status === "PENDING") k.status = "REVOKED"; // superseded_unconfirmed
      const id = randomUUID();
      const t = `ulk_${id}.${randomBytes(32).toString("base64url")}`;
      keys.set(t, { id, token: t, org: pr.org, pr: pr.id, status: "PENDING" });
      pr.status = "ISSUED";
      pr.issueCount++;
      pr.current = id;
      counters.issue++;
      return send(res, 201, { data: { provisioningRequest: { id: pr.id }, credential: { id, status: "PENDING", token: t } } });
    }
    const confirm = /^\/v1\/service\/credential-provisionings\/([^/]+)\/confirm$/.exec(url);
    if (confirm && req.method === "POST") {
      if (!key) return err(res, 401, "UNAUTHORIZED");
      if (key.status === "REVOKED") return err(res, 401, "CREDENTIAL_REVOKED");
      const pr = requests.get(confirm[1]!);
      if (!pr || key.pr !== pr.id) return err(res, 404, "NOT_FOUND");
      if (knobs.failConfirmUnprocessed > 0) {
        knobs.failConfirmUnprocessed--;
        return err(res, 503, "UNAVAILABLE"); // nothing processed
      }
      if (pr.status === "ACTIVE" && pr.current === key.id) return send(res, 200, { data: { id: pr.id, status: "ACTIVE" } });
      if (pr.status !== "ISSUED" || pr.current !== key.id || key.status !== "PENDING") return err(res, 409, "PROVISIONING_CREDENTIAL_NOT_CURRENT");
      key.status = "ACTIVE";
      pr.status = "ACTIVE";
      counters.confirm++;
      if (knobs.dropConfirmResponse > 0) {
        knobs.dropConfirmResponse--;
        return req.socket.destroy(); // processed, response lost
      }
      return send(res, 200, { data: { id: pr.id, status: "ACTIVE" } });
    }
    if (/\/applications\/NA_PISTA\/entitlements$/.test(url)) {
      if (!key) return err(res, 401, "UNAUTHORIZED");
      if (key.status === "REVOKED") return err(res, 401, "CREDENTIAL_REVOKED");
      if (key.status !== "ACTIVE") return err(res, 401, "UNAUTHORIZED");
      return send(res, 200, { data: { application: { key: "NA_PISTA", name: "Na Pista" }, subscription: { id: "s", status: "active", planKey: "BUSINESS" }, entitlements: [{ key: "catalog.enabled", value: true }] } });
    }
    return err(res, 404, "NOT_FOUND");
  });
});
await new Promise<void>((r) => platform.listen(0, "127.0.0.1", () => r()));
process.env.PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/v1`;

// Modules are imported only now, so env.ts reads the simulated Platform URL.
const { db, queryClient } = await import("../../src/db/index.js");
const { organizationPlatformCredentials } = await import("../../src/db/schema/index.js");
const { reconcileOnce } = await import("../../src/modules/platformCredentials/reconciler.js");
const { resolvePlatformCredential, invalidatePlatformCredentialCache, PlatformCredentialUnavailableError } = await import("../../src/modules/platformCredentials/resolver.js");
const { storePendingManagedCredential } = await import("../../src/modules/platformCredentials/service.js");
const { fetchEntitlements, _clearEntitlementsCache } = await import("../../src/platform/entitlements.js");
const { introspectServiceCredential, _clearServiceIdentityCache } = await import("../../src/platform/serviceIntrospection.js");
const { requiresApplicationAccess } = await import("../../src/tenancy/tenantContext.js");
const { eq, inArray } = await import("drizzle-orm");

// The same key the runtime resolver uses (a local fixture from the test environment), so stored rows are usable by fetchEntitlements.
const testKey = Buffer.from(process.env.NA_PISTA_CREDENTIAL_ENCRYPTION_KEY ?? "", "base64");
assert.equal(testKey.length, 32);
const key = () => testKey;
const orgIds: string[] = [];

function newRequest() {
  const org = randomUUID();
  orgIds.push(org);
  const pr: Req = { id: randomUUID(), org, status: "REQUESTED", issueCount: 0, current: null };
  requests.set(pr.id, pr);
  return pr;
}
const rowsOf = (org: string) => db.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, org));
const reconcile = () => reconcileOnce({ provisioningCredential: PROVISIONER, key, requestId: "test" });
const settleOthers = () => {
  for (const r of requests.values()) if (r.status === "REQUESTED" || r.status === "ISSUED") r.status = "CANCELLED";
};

after(async () => {
  platform.close();
  if (orgIds.length) await db.delete(organizationPlatformCredentials).where(inArray(organizationPlatformCredentials.organizationId, orgIds));
  await queryClient.end();
});

test("happy path: open request → issue → introspect → F29A PENDING → confirm → ACTIVE; the resolver serves it", async () => {
  settleOthers();
  const pr = newRequest();
  const result = await reconcile();
  assert.equal(result.issued, 1);
  assert.equal(result.confirmed, 1);
  assert.equal(pr.status, "ACTIVE");
  const [row] = await rowsOf(pr.org);
  assert.equal(row!.status, "ACTIVE");
  assert.equal(row!.provisioningRequestId, pr.id);
  assert.equal(row!.platformApiKeyId, pr.current);
  const token = [...keys.values()].find((k) => k.id === pr.current)!.token;
  assert.ok(row!.encryptedCredential.startsWith("v1:") && !row!.encryptedCredential.includes(token.split(".")[1]!), "encrypted, never plaintext");
  invalidatePlatformCredentialCache(pr.org);
  assert.equal(await resolvePlatformCredential(pr.org, { key }), token);
  assert.equal((await reconcile()).issued, 0, "converged: nothing more to do");
});

test("stored, then the confirmation response was lost → next cycle confirms (idempotent), never re-issues", async () => {
  settleOthers();
  const pr = newRequest();
  knobs.dropConfirmResponse = 1;
  const before = counters.issue;
  const first = await reconcile();
  assert.equal(first.issued, 1);
  assert.equal((await rowsOf(pr.org))[0]!.status, "PENDING", "durably stored before confirming");
  assert.equal(pr.status, "ACTIVE", "the Platform processed the confirmation");
  const second = await reconcile();
  assert.equal(second.confirmed, 1);
  assert.equal(second.issued, 0);
  assert.equal(counters.issue - before, 1, "exactly one issuance");
  assert.equal((await rowsOf(pr.org))[0]!.status, "ACTIVE");
});

test("stored, confirmation not processed (transient) → next cycle confirms the SAME credential", async () => {
  settleOthers();
  const pr = newRequest();
  knobs.failConfirmUnprocessed = 1;
  const first = await reconcile();
  assert.equal(first.failed, 1);
  assert.equal(pr.status, "ISSUED");
  const held = (await rowsOf(pr.org))[0]!;
  assert.equal(held.status, "PENDING");
  await reconcile();
  assert.equal(pr.status, "ACTIVE");
  assert.equal(pr.issueCount, 1);
  assert.equal((await rowsOf(pr.org))[0]!.platformApiKeyId, held.platformApiKeyId);
});

test("a held PENDING credential whose confirmation keeps failing transiently never triggers a new issuance", async () => {
  settleOthers();
  const pr = newRequest();
  knobs.failConfirmUnprocessed = 1;
  await reconcile(); // issued + stored PENDING; confirmation not processed
  knobs.failConfirmUnprocessed = 1;
  const second = await reconcile(); // step 1 fails again; the request is still open in step 2
  assert.equal(second.issued, 0, "held → never re-issued");
  assert.equal(pr.issueCount, 1);
  await reconcile();
  assert.equal(pr.status, "ACTIVE");
  assert.equal(pr.issueCount, 1);
});

test("received but NOT stored → nothing held → next cycle asks again; the Platform supersedes the unconfirmed one", async () => {
  settleOthers();
  const pr = newRequest();
  const broken = () => Buffer.alloc(5); // encryption fails before anything is stored
  const first = await reconcileOnce({ provisioningCredential: PROVISIONER, key: broken, requestId: "test" });
  assert.equal(first.issued, 1);
  assert.equal(first.failed, 1);
  assert.equal((await rowsOf(pr.org)).length, 0);
  const firstKey = pr.current;
  await reconcile();
  assert.equal(pr.status, "ACTIVE");
  assert.equal(pr.issueCount, 2);
  assert.equal([...keys.values()].find((k) => k.id === firstKey)!.status, "REVOKED", "the lost one is dead");
  const rows = await rowsOf(pr.org);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.platformApiKeyId, pr.current);
});

test("two reconcilers at once converge to exactly one ACTIVE credential", async () => {
  settleOthers();
  const pr = newRequest();
  await Promise.all([reconcile(), reconcile()]);
  await reconcile();
  const rows = await rowsOf(pr.org);
  assert.equal(rows.filter((r) => r.status === "ACTIVE").length, 1);
  assert.equal(rows.filter((r) => r.status === "PENDING").length, 0);
  assert.equal(pr.status, "ACTIVE");
});

test("a held PENDING credential the Platform refuses (superseded elsewhere) is retired locally", async () => {
  settleOthers();
  const pr = newRequest();
  knobs.failConfirmUnprocessed = 1;
  await reconcile(); // stored PENDING, not confirmed
  const held = (await rowsOf(pr.org))[0]!;
  // Someone re-issued meanwhile: the held one is superseded at the Platform.
  for (const k of keys.values()) if (k.id === held.platformApiKeyId) k.status = "REVOKED";
  pr.status = "ISSUED";
  await reconcile();
  const rows = await rowsOf(pr.org);
  assert.equal(rows.find((r) => r.platformApiKeyId === held.platformApiKeyId)!.status, "REVOKED");
});

test("outbound: CREDENTIAL_REVOKED from the Platform retires the local credential; the call fails closed", async () => {
  settleOthers();
  const pr = newRequest();
  await reconcile();
  const k = [...keys.values()].find((x) => x.id === pr.current)!;
  k.status = "REVOKED";
  _clearEntitlementsCache();
  invalidatePlatformCredentialCache(pr.org);
  await assert.rejects(fetchEntitlements(pr.org, "test"), (e: unknown) => (e as { statusCode?: number }).statusCode === 503);
  assert.equal((await rowsOf(pr.org))[0]!.status, "REVOKED");
  invalidatePlatformCredentialCache(pr.org);
  await assert.rejects(resolvePlatformCredential(pr.org, { key }), (e: unknown) => e instanceof PlatformCredentialUnavailableError && e.reason === "REVOKED");
});

test("store refuses anything that is not this request's PENDING managed NA_PISTA credential of this organization", async () => {
  const org = randomUUID();
  const prId = randomUUID();
  orgIds.push(org);
  const base = { apiKeyId: randomUUID(), application: "NA_PISTA", organizationId: org, credentialClass: "INTEGRATION_MANAGED", purpose: "platform_integration", status: "PENDING", provisioningRequestId: prId };
  const actor = { type: "service" as const, id: "test" };
  const tryWith = (over: Record<string, unknown>) =>
    storePendingManagedCredential({ organizationId: org, provisioningRequestId: prId, credential: "ulk_x.y" }, { actor, key, introspect: async () => ({ ...base, ...over }) as never });
  for (const over of [{ credentialClass: "ORGANIZATION" }, { status: "ACTIVE" }, { organizationId: randomUUID() }, { provisioningRequestId: randomUUID() }, { application: "QUALE_A_DICA" }, { purpose: null }]) {
    await assert.rejects(tryWith(over), (e: unknown) => (e as { statusCode?: number }).statusCode === 400, JSON.stringify(over));
  }
  assert.equal((await rowsOf(org)).length, 0);
});

test("the resolver never serves a PENDING credential", async () => {
  settleOthers();
  const pr = newRequest();
  knobs.failConfirmUnprocessed = 1;
  await reconcile();
  assert.equal((await rowsOf(pr.org))[0]!.status, "PENDING");
  invalidatePlatformCredentialCache(pr.org);
  await assert.rejects(resolvePlatformCredential(pr.org, { key }), (e: unknown) => e instanceof PlatformCredentialUnavailableError && e.reason === "NOT_PROVISIONED");
  await reconcile();
});

test("inbound: a managed credential (or one without a class) is never accepted as a caller of Na Pista", async () => {
  settleOthers();
  const pr = newRequest();
  await reconcile();
  const managed = [...keys.values()].find((x) => x.id === pr.current)!.token;
  _clearServiceIdentityCache();
  await assert.rejects(introspectServiceCredential(managed), (e: unknown) => (e as { statusCode?: number }).statusCode === 401);
});

test("production never relaxes the application-access check, whatever the variable says", () => {
  assert.equal(requiresApplicationAccess("production", "false"), true);
  assert.equal(requiresApplicationAccess("production", "true"), true);
  assert.equal(requiresApplicationAccess("development", "false"), false);
  assert.equal(requiresApplicationAccess("test", "true"), true);
});

test("no secret in the logs of a full reconcile cycle", async () => {
  settleOthers();
  const pr = newRequest();
  const writes: string[] = [];
  const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((c: unknown, ...r: unknown[]) => (writes.push(String(c)), orig.out(c as string, ...(r as [])))) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown, ...r: unknown[]) => (writes.push(String(c)), orig.err(c as string, ...(r as [])))) as typeof process.stderr.write;
  try {
    await reconcile();
  } finally {
    process.stdout.write = orig.out;
    process.stderr.write = orig.err;
  }
  const secretPart = [...keys.values()].find((x) => x.id === pr.current)!.token.split(".")[1]!;
  for (const w of writes) assert.ok(!w.includes(secretPart) && !w.includes("ulk_"), "secret in a log line");
  assert.ok(!anyWriteContains(PROVISIONER, writes));
});

function anyWriteContains(needle: string, writes: string[]) {
  return writes.some((w) => w.includes(needle.split(".")[1]!));
}
