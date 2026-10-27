import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import express from "express";
import { buildApp } from "../../src/app.js";
import { env } from "../../src/config/env.js";
import { errorHandler } from "../../src/middleware/errorHandler.js";

/**
 * Readiness audit 2026-10-22 (no Platform, no PostgreSQL):
 *  - P1-4a: API responses are never cacheable nor conditional (no ETag → no 304 whose CORS headers Vercel strips);
 *  - P1-1: a deadlock / serialization victim (rolled back as a whole) is a retryable 409 CONCURRENT_UPDATE, never a
 *    500, and the driver's message never reaches the client.
 */
let server: Server;
let base: string;
const origin = env.NA_PISTA_ALLOWED_ORIGINS[0]!;

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = buildApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("API responses carry Cache-Control: no-store and no ETag", async () => {
  for (const path of ["/health", "/openapi.json"]) {
    const res = await fetch(`${base}${path}`, { headers: { Origin: origin } });
    await res.text();
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("etag"), null, path);
    assert.equal(res.headers.get("access-control-allow-origin"), origin, path);
  }
});

test("a conditional request is answered in full (never 304), with the caller's CORS headers", async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: origin, "If-None-Match": 'W/"anything"' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), origin);
  await res.text();
});

test("CORS is unchanged: an origin outside the allow-list gets no Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: "https://not-allowed.invalid" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  await res.text();
});

async function errorFor(error: unknown) {
  const app = express();
  app.get("/boom", () => {
    throw error;
  });
  app.use(errorHandler);
  const s = await new Promise<Server>((resolve) => {
    const x = app.listen(0, "127.0.0.1", () => resolve(x));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(s.address() as { port: number }).port}/boom`);
    return { status: res.status, text: await res.text() };
  } finally {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

test("deadlock (40P01) and serialization failure (40001), also wrapped as a driver cause → 409 CONCURRENT_UPDATE, no driver text", async () => {
  const driver = (code: string) => Object.assign(new Error(`deadlock detected: Process 123 waits for ShareLock on transaction 456 (${code})`), { code });
  for (const error of [driver("40P01"), driver("40001"), Object.assign(new Error("Failed query: update inventory_balances"), { cause: driver("40P01") })]) {
    const { status, text } = await errorFor(error);
    assert.equal(status, 409);
    assert.equal(JSON.parse(text).error.code, "CONCURRENT_UPDATE");
    assert.ok(!/Process 123|ShareLock|inventory_balances/.test(text), "driver details stay in the server log");
  }
});

test("other unexpected errors are still a 500 INTERNAL_ERROR", async () => {
  const { status, text } = await errorFor(Object.assign(new Error("boom"), { code: "XX000" }));
  assert.equal(status, 500);
  assert.equal(JSON.parse(text).error.code, "INTERNAL_ERROR");
});
