import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { env } from "../../src/config/env.js";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/**
 * ADR-073 over HTTP, live against the local UL Platform (F20 fixtures, org A). The integration key holds the
 * per-resource scopes (ul-platform fixtures). Everything an external interface would see.
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fx = loadFixtures();
const orgA = fx.orgA.id;
const svc = fx.apiKeys.integrationA.secret;
const owner = fx.orgA.ownerToken;

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fx);
});
after(() => ctx.close());

const post = (path: string, token: string, body: unknown, key?: string) =>
  call(ctx.base, "POST", `/organizations/${orgA}${path}`, { token, body, headers: key === undefined ? {} : { "idempotency-key": key } });

test("service credential without Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED, nothing created", async () => {
  const listBefore = await call(ctx.base, "GET", `/organizations/${orgA}/customers?pageSize=1`, { token: owner });
  const r = await post("/customers", svc, { name: "Sem chave" });
  assert.equal(r.status, 400);
  assert.equal(r.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  const afterRes = await call(ctx.base, "GET", `/organizations/${orgA}/customers?pageSize=1`, { token: owner });
  assert.equal(JSON.stringify(afterRes.data), JSON.stringify(listBefore.data), "no customer was created");
});

test("same key, same request → 201 twice, same customer; the replay says so in Idempotent-Replayed", async () => {
  const key = randomUUID();
  const a = await post("/customers", svc, { name: "Cliente Repetido", phone: "+244900000001" }, key);
  const b = await post("/customers", svc, { name: "Cliente Repetido", phone: "+244900000001" }, key);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(b.data.id, a.data.id);
  assert.equal(a.headers.get("idempotent-replayed"), null);
  assert.equal(b.headers.get("idempotent-replayed"), "true");
});

test("same key, different request → 409 IDEMPOTENCY_KEY_REUSED", async () => {
  const key = randomUUID();
  assert.equal((await post("/customers", svc, { name: "Primeiro" }, key)).status, 201);
  const r = await post("/customers", svc, { name: "Outro nome" }, key);
  assert.equal(r.status, 409);
  assert.equal(r.error.code, "IDEMPOTENCY_KEY_REUSED");
});

test("malformed key → 400 VALIDATION_ERROR located on the header", async () => {
  const r = await post("/customers", svc, { name: "X" }, "duas palavras");
  assert.equal(r.status, 400);
  assert.equal(r.error.code, "VALIDATION_ERROR");
  assert.equal(r.error.details?.[0]?.location, "header");
});

test("a user (Console) without the header still creates normally", async () => {
  const r = await post("/customers", owner, { name: "Criado na Console" });
  assert.equal(r.status, 201);
});

test("orders: 5 simultaneous submissions with one key → one order", async () => {
  const product = await post("/products", owner, { name: `Idem ${randomUUID().slice(0, 6)}`, price: "10.00" });
  assert.equal(product.status, 201);
  const key = randomUUID();
  const body = { items: [{ productId: product.data.id, quantity: 2 }] };
  const results = await Promise.all(Array.from({ length: 5 }, () => post("/orders", svc, body, key)));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  assert.equal(new Set(results.map((r) => r.data.id)).size, 1);
  assert.equal(results.filter((r) => r.headers.get("idempotent-replayed") === "true").length, 4);
});

test("stock: a retried RECEIPT with the same key moves the balance once", async () => {
  const product = await post("/products", owner, { name: `Stock ${randomUUID().slice(0, 6)}`, price: "1.00" });
  const key = randomUUID();
  const body = { type: "RECEIPT", quantity: 7 };
  assert.equal((await post(`/inventory/${product.data.id}/movements`, svc, body, key)).status, 201);
  assert.equal((await post(`/inventory/${product.data.id}/movements`, svc, body, key)).status, 201);
  const balance = await call(ctx.base, "GET", `/organizations/${orgA}/inventory/${product.data.id}`, { token: owner });
  assert.equal(Number(balance.data.quantity), 7);
});

test("CORS preflight from an allowed origin accepts the Idempotency-Key header (future browser interface)", async () => {
  const origin = env.NA_PISTA_ALLOWED_ORIGINS[0]!;
  const res = await fetch(`${ctx.base}/organizations/${orgA}/orders`, {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,idempotency-key" },
  });
  assert.ok(res.status === 204 || res.status === 200);
  assert.match(res.headers.get("access-control-allow-headers") ?? "", /idempotency-key/i);
});
