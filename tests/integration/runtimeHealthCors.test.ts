import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import express from "express";
import { buildApp } from "../../src/app.js";
import { queryClient } from "../../src/db/index.js";
import { readinessHandler } from "../../src/health/readiness.js";

/**
 * Runtime readiness — liveness, readiness and CORS on the real app, against the local (guarded) test
 * database. No credential, no Platform call: every route exercised here is public or answered before
 * authentication.
 */
let server: Server;
let base = "";

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = buildApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await queryClient.end();
});

test("liveness and readiness are public; readiness checks the database and says nothing else", async () => {
  const live = await fetch(`${base}/health`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { data: { status: "ok" } });
  const ready = await fetch(`${base}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { data: { status: "ready" } });
});

async function probeApp(probe: () => Promise<void>, timeoutMs = 50) {
  const app = express();
  app.get("/ready", readinessHandler(probe, timeoutMs));
  const s = await new Promise<Server>((resolve) => {
    const x = app.listen(0, "127.0.0.1", () => resolve(x));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/ready`);
    return { status: res.status, body: await res.text() };
  } finally {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

test("database failure or hang → 503 NOT_READY, without connection details", async () => {
  const failing = await probeApp(async () => {
    throw new Error("connect ECONNREFUSED postgresql://user:secret@db.internal.invalid:5432/x");
  });
  assert.equal(failing.status, 503);
  assert.deepEqual(JSON.parse(failing.body), { error: { code: "NOT_READY", message: "Service not ready" } });
  assert.doesNotMatch(failing.body, /secret|invalid|postgres/);
  const hanging = await probeApp(() => new Promise<void>(() => {}), 50);
  assert.equal(hanging.status, 503);
});

test("CORS: the allowed local origin is echoed; any other origin gets no CORS grant; no wildcard", async () => {
  const allowed = await fetch(`${base}/health`, { headers: { origin: "http://localhost:3010" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3010");
  const other = await fetch(`${base}/health`, { headers: { origin: "https://evil.invalid" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  const preflight = await fetch(`${base}/health`, { method: "OPTIONS", headers: { origin: "https://evil.invalid", "access-control-request-method": "POST" } });
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
  assert.notEqual(allowed.headers.get("access-control-allow-origin"), "*");
});

test("server-to-server (no Origin header) is unaffected by CORS", async () => {
  const res = await fetch(`${base}/health/ready`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
