import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { z } from "zod";
import { buildApp } from "../../src/app.js";
import { ValidationError } from "../../src/shared/errors.js";
import { parseBody, parseQuery, toValidationIssues } from "../../src/shared/validate.js";

/**
 * ADR-053 — the parts of the public error contract that need neither the
 * Platform nor PostgreSQL (they fail before authentication or are pure
 * helpers). Authenticated cases (path ids, authenticated 404) are covered
 * over real HTTP in tests/e2e/contract-errors.test.ts.
 */
let server: Server;
let base: string;

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = buildApp().listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { res, json: json as { error?: { code: string; message: string; details?: unknown[] } } | undefined, text };
}

test("malformed JSON body → 400 VALIDATION_ERROR (was 500), with X-Request-ID, no body echo", async () => {
  const { res, json, text } = await call("/v1/organizations/00000000-0000-0000-0000-000000000000/products", {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": "err-contract-1" },
    body: '{"name": "secret-ish-value"',
  });
  assert.equal(res.status, 400);
  assert.equal(json?.error?.code, "VALIDATION_ERROR");
  assert.equal(res.headers.get("x-request-id"), "err-contract-1");
  assert.ok(!text.includes("secret-ish-value"), "the rejected body is never echoed");
  assert.ok(!/SyntaxError|at JSON\.parse|node_modules/.test(text), "no parser internals");
});

test("oversize body → 413 PAYLOAD_TOO_LARGE", async () => {
  const { res, json } = await call("/v1/organizations/00000000-0000-0000-0000-000000000000/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(200_000) }),
  });
  assert.equal(res.status, 413);
  assert.equal(json?.error?.code, "PAYLOAD_TOO_LARGE");
});

test("unmatched route outside /v1 → JSON 404 NOT_FOUND (was Express HTML)", async () => {
  const { res, json } = await call("/v2/anything");
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(json?.error?.code, "NOT_FOUND");
  assert.ok(res.headers.get("x-request-id"));
});

test("unmatched route under /v1 without credentials → 401 first (route existence not disclosed)", async () => {
  const { res, json } = await call("/v1/definitely-not-a-route");
  assert.equal(res.status, 401);
  assert.equal(json?.error?.code, "UNAUTHORIZED");
});

test("health stays public and unchanged", async () => {
  const { res, json } = await call("/v1/health");
  assert.equal(res.status, 200);
  assert.deepEqual(json, { data: { status: "ok" } });
});

test("parseBody/parseQuery: details carry location + dotted path + message, never the rejected value", () => {
  const schema = z.object({ items: z.array(z.object({ quantity: z.number().positive() })) }).strict();
  const error = (() => {
    try {
      parseBody(schema, { items: [{ quantity: -7 }], extra: "hunter2" });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(error instanceof ValidationError);
  assert.equal(error.statusCode, 400);
  assert.equal(error.message, "Invalid request payload");
  const details = error.details ?? [];
  assert.ok(details.some((d) => d.location === "body" && d.path === "items.0.quantity"), JSON.stringify(details));
  assert.ok(details.some((d) => d.location === "body" && d.path === "extra"), "unknown key reported by name");
  assert.ok(!JSON.stringify(details).includes("hunter2") && !JSON.stringify(details).includes("-7"), "values never echoed");

  const q = (() => {
    try {
      parseQuery(z.object({ pageSize: z.coerce.number().int().max(100) }).strict(), { pageSize: "500" });
    } catch (e) {
      return e as ValidationError;
    }
  })();
  assert.deepEqual(q?.details?.map((d) => [d.location, d.path]), [["query", "pageSize"]]);
});

test("toValidationIssues without a location omits it", () => {
  const result = z.object({ a: z.string() }).safeParse({});
  assert.equal(result.success, false);
  const issues = toValidationIssues(result.error!);
  assert.deepEqual(Object.keys(issues[0]!).sort(), ["message", "path"]);
});
