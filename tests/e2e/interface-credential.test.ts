import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { _clearServiceIdentityCache } from "../../src/platform/serviceIntrospection.js";
import { call, loadFixtures, registerFixtureCredentials, startApp } from "./helpers.js";

/**
 * Interface credential, live against the local UL Platform (scopes from UL migration 0033): the server-side key of a
 * customer-facing interface holds `catalog.read`, `customer.create` and `order.create` — it shows the catalog, creates
 * the buyer and the order, and reads back only its own orders. Everything else is refused. Org A (F20 fixtures).
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fx = loadFixtures();
const orgA = fx.orgA.id;
const owner = fx.orgA.ownerToken;
let iface = "";
let productId = "";

const as = (token: string, method: string, path: string, body?: unknown, key?: string) =>
  call(ctx.base, method, `/organizations/${orgA}${path}`, { token, body, headers: key ? { "idempotency-key": key } : {} });

before(async () => {
  ctx = await startApp();
  registerFixtureCredentials(fx);
  const res = await fetch(`${fx.platformBaseUrl}/organizations/${orgA}/api-keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
    body: JSON.stringify({ applicationKey: "NA_PISTA", scopes: ["catalog.read", "customer.create", "order.create"] }),
  });
  assert.equal(res.status, 201, "the OWNER can mint an interface key (UL 0033 scopes)");
  iface = ((await res.json()) as { data: { secret: string } }).data.secret;
  const p = await as(owner, "POST", "/products", { name: `Interface ${randomUUID().slice(0, 6)}`, price: "15.00" });
  productId = p.data.id;
  await as(owner, "POST", `/inventory/${productId}/movements`, { type: "RECEIPT", quantity: 10 });
});
after(() => ctx.close());

test("the interface path: catalog → create buyer → create order → read it back → the owner confirms → the interface sees CONFIRMED", async () => {
  assert.equal((await as(iface, "GET", "/products")).status, 200, "shows the catalog");
  const buyer = await as(iface, "POST", "/customers", { name: "Comprador Fictício", phone: "+244900000002" }, randomUUID());
  assert.equal(buyer.status, 201);
  const key = randomUUID();
  const order = await as(iface, "POST", "/orders", { customerId: buyer.data.id, items: [{ productId, quantity: 2 }] }, key);
  assert.equal(order.status, 201);
  assert.equal(order.data.status, "DRAFT");
  const again = await as(iface, "POST", "/orders", { customerId: buyer.data.id, items: [{ productId, quantity: 2 }] }, key);
  assert.equal(again.data.id, order.data.id, "a retried submission is the same order");
  const own = await as(iface, "GET", `/orders/${order.data.id}`);
  assert.equal(own.status, 200);
  assert.equal(own.data.total, "30.00");
  assert.equal((await as(owner, "POST", `/orders/${order.data.id}/confirm`)).status, 200, "the owner confirms in the Console");
  assert.equal((await as(iface, "GET", `/orders/${order.data.id}`)).data.status, "CONFIRMED", "the interface shows the result");
});

test("own orders only: an order created by someone else is 404 for the interface key (not disclosed)", async () => {
  const other = await as(owner, "POST", "/orders", { items: [{ productId, quantity: 1 }] });
  assert.equal(other.status, 201);
  const r = await as(iface, "GET", `/orders/${other.data.id}`);
  assert.equal(r.status, 404);
  assert.equal(r.error.code, "ORDER_NOT_FOUND");
});

test("everything else is refused: listing orders, managing orders, reading customers, stock, writing the catalog", async () => {
  const mine = await as(iface, "POST", "/orders", { items: [{ productId, quantity: 1 }] }, randomUUID());
  assert.equal(mine.status, 201);
  const id = mine.data.id;
  const refused: [string, string, unknown?][] = [
    ["GET", "/orders"],
    ["POST", `/orders/${id}/confirm`],
    ["POST", `/orders/${id}/cancel`],
    ["PATCH", `/orders/${id}`, { customerId: null }],
    ["POST", `/orders/${id}/items`, { productId, quantity: 1 }],
    ["GET", "/customers"],
    ["POST", `/inventory/${productId}/movements`, { type: "RECEIPT", quantity: 1 }],
    ["POST", "/products", { name: "Não pode" }],
  ];
  for (const [method, path, body] of refused) {
    const r = await as(iface, method, path, body, randomUUID());
    assert.equal(r.status, 403, `${method} ${path}`);
  }
});

test("isolation and revocation: another organization's path → 403; a revoked interface key → 401", async () => {
  const cross = await call(ctx.base, "GET", `/organizations/${fx.orgB.id}/products`, { token: iface });
  assert.equal(cross.status, 403);
  const list = await fetch(`${fx.platformBaseUrl}/organizations/${orgA}/api-keys`, { headers: { authorization: `Bearer ${owner}` } });
  const keys = ((await list.json()) as { data: { id: string; scopes: string[]; status: string }[] }).data;
  const mine = keys.find((k) => k.status === "ACTIVE" && k.scopes.includes("order.create") && !k.scopes.includes("order.write"))!;
  const rev = await fetch(`${fx.platformBaseUrl}/organizations/${orgA}/api-keys/${mine.id}/revoke`, { method: "POST", headers: { authorization: `Bearer ${owner}` } });
  assert.equal(rev.status, 200);
  _clearServiceIdentityCache();
  assert.equal((await as(iface, "GET", "/products")).status, 401);
});
