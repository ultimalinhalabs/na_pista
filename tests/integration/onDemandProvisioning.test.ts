import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";

/**
 * On-demand provisioning (owner decision 2026-10-18 — no 24/7 worker): the first request of an organization
 * without a credential pulls it at once (resolver → reconcileOnDemand), concurrent requests share ONE cycle, an
 * unprovisioned organization is throttled, and the daily Vercel Cron route is hidden without its bearer secret.
 * Same LOCAL simulated Platform as managedCredentialProvisioning.test.ts; nothing leaves the machine.
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
const listCalls = { n: 0 };
platform.on("request", (req) => {
  if (req.url === "/v1/service/credential-provisionings" && req.method === "GET") listCalls.n++;
});
await new Promise<void>((r) => platform.listen(0, "127.0.0.1", () => r()));
process.env.PLATFORM_API_URL = `http://127.0.0.1:${(platform.address() as AddressInfo).port}/v1`;
process.env.NA_PISTA_PROVISIONING_CREDENTIAL = PROVISIONER;
const CRON = randomBytes(24).toString("base64url");
process.env.CRON_SECRET = CRON;

const { db, queryClient } = await import("../../src/db/index.js");
const { organizationPlatformCredentials } = await import("../../src/db/schema/index.js");
const { _resetOnDemandReconcile } = await import("../../src/modules/platformCredentials/reconciler.js");
const { resolvePlatformCredential, invalidatePlatformCredentialCache, PlatformCredentialUnavailableError } = await import("../../src/modules/platformCredentials/resolver.js");
const { buildApp } = await import("../../src/app.js");
const { inArray } = await import("drizzle-orm");

const orgIds: string[] = [];
function newRequest() {
  const org = randomUUID();
  orgIds.push(org);
  const pr: Req = { id: randomUUID(), org, status: "REQUESTED", issueCount: 0, current: null };
  requests.set(pr.id, pr);
  return pr;
}
const settleOthers = () => {
  for (const r of requests.values()) if (r.status === "REQUESTED" || r.status === "ISSUED") r.status = "CANCELLED";
};
const server = buildApp().listen(0);
const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(async () => {
  server.close();
  platform.close();
  if (orgIds.length) await db.delete(organizationPlatformCredentials).where(inArray(organizationPlatformCredentials.organizationId, orgIds));
  await queryClient.end();
});

test("first request of a just-activated organization pulls its credential at once (no background worker)", async () => {
  settleOthers();
  _resetOnDemandReconcile();
  const pr = newRequest();
  invalidatePlatformCredentialCache(pr.org);
  const credential = await resolvePlatformCredential(pr.org);
  assert.match(credential, /^ulk_/);
  assert.equal(pr.status, "ACTIVE");
});

test("concurrent first requests share ONE reconcile cycle and ONE issuance", async () => {
  settleOthers();
  _resetOnDemandReconcile();
  const pr = newRequest();
  invalidatePlatformCredentialCache(pr.org);
  const issuesBefore = counters.issue;
  const listBefore = listCalls.n;
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => resolvePlatformCredential(pr.org)));
  assert.equal(new Set(results).size, 1);
  assert.equal(counters.issue - issuesBefore, 1);
  assert.equal(listCalls.n - listBefore, 1);
});

test("an organization that is not provisioned is throttled: no Platform traffic on every request", async () => {
  settleOthers();
  _resetOnDemandReconcile();
  const org = randomUUID();
  const listBefore = listCalls.n;
  for (let i = 0; i < 3; i++) {
    invalidatePlatformCredentialCache(org);
    await assert.rejects(resolvePlatformCredential(org), PlatformCredentialUnavailableError);
  }
  assert.equal(listCalls.n - listBefore, 1, "one cycle, then throttled");
});

test("daily cron route: hidden (404) without or with a wrong bearer; with CRON_SECRET it runs one cycle and returns counts only", async () => {
  settleOthers();
  const url = `${base()}/v1/internal/cron/reconcile-provisioning`;
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await fetch(url, { headers: { authorization: "Bearer wrong-secret-wrong-secret" } })).status, 404);
  const pr = newRequest();
  const res = await fetch(url, { headers: { authorization: `Bearer ${CRON}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.ran, true);
  assert.equal(body.data.issued, 1);
  assert.equal(pr.status, "ACTIVE");
  assert.doesNotMatch(JSON.stringify(body), /ulk_/);
});
