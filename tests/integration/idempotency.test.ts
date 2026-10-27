import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, count, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { auditEvents, customers, orders, stockMovements } from "../../src/db/schema/index.js";
import { createCustomerIdempotent } from "../../src/modules/customers/service.js";
import { hashRequest, type IdempotencyRequest } from "../../src/modules/idempotency/service.js";
import { getBalance } from "../../src/modules/inventory/repository.js";
import { createMovementIdempotent } from "../../src/modules/inventory/service.js";
import { createOrderIdempotent } from "../../src/modules/orders/service.js";
import { insertProduct, updateProduct } from "../../src/modules/products/repository.js";
import { IdempotencyKeyReusedError, ProductPriceRequiredError } from "../../src/shared/errors.js";

/** ADR-073 on real PostgreSQL: a retried create is applied once; the key is scoped and never burned by a failure. */
after(() => queryClient.end());

const service = { type: "service" as const, id: "key-A" };
const idem = (operation: string, payload: unknown, key = randomUUID()): IdempotencyRequest => ({ key, operation, requestHash: hashRequest(operation, payload) });
const ordersIn = async (organizationId: string) => (await db.select({ n: count() }).from(orders).where(eq(orders.organizationId, organizationId)))[0]!.n;

async function pricedProduct(org: { organizationId: string }) {
  return insertProduct(org, { name: `P ${randomUUID().slice(0, 6)}`, price: "10.00" });
}

test("orders: the same key and request twice → one order, same id, the second replayed; one audit event", async () => {
  const org = { organizationId: randomUUID() };
  const p = await pricedProduct(org);
  const input = { items: [{ productId: p.id, quantity: "2" }] };
  const key = idem("orders.create", { body: input });
  const first = await createOrderIdempotent(org, service, "req-1", input, key);
  const second = await createOrderIdempotent(org, service, "req-2-retry", input, key);
  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.result.id, first.result.id);
  assert.equal(second.result.total, first.result.total);
  assert.equal(await ordersIn(org.organizationId), 1);
  const audits = await db.select({ n: count() }).from(auditEvents).where(and(eq(auditEvents.organizationId, org.organizationId), eq(auditEvents.action, "order.created")));
  assert.equal(audits[0]!.n, 1);
});

test("orders: the same key with a different request → 409 IDEMPOTENCY_KEY_REUSED, nothing written", async () => {
  const org = { organizationId: randomUUID() };
  const p = await pricedProduct(org);
  const key = randomUUID();
  await createOrderIdempotent(org, service, "r", { items: [{ productId: p.id, quantity: "1" }] }, idem("orders.create", { body: { items: [{ productId: p.id, quantity: "1" }] } }, key));
  await assert.rejects(
    createOrderIdempotent(org, service, "r", { items: [{ productId: p.id, quantity: "5" }] }, idem("orders.create", { body: { items: [{ productId: p.id, quantity: "5" }] } }, key)),
    IdempotencyKeyReusedError,
  );
  assert.equal(await ordersIn(org.organizationId), 1);
});

test("orders: 10 simultaneous requests with the same key → exactly one order; the other nine replay it", async () => {
  const org = { organizationId: randomUUID() };
  const p = await pricedProduct(org);
  const input = { items: [{ productId: p.id, quantity: "1" }] };
  const key = idem("orders.create", { body: input });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createOrderIdempotent(org, service, `req-${i}`, input, key)));
  assert.equal(new Set(results.map((r) => r.result.id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(await ordersIn(org.organizationId), 1);
});

test("scope: the same key from another actor, or in another organization, is a different intent", async () => {
  const org = { organizationId: randomUUID() };
  const p = await pricedProduct(org);
  const input = { items: [{ productId: p.id, quantity: "1" }] };
  const key = randomUUID();
  const a = await createOrderIdempotent(org, service, "r", input, idem("orders.create", { body: input }, key));
  const b = await createOrderIdempotent(org, { type: "user", id: "user-1" }, "r", input, idem("orders.create", { body: input }, key));
  assert.notEqual(a.result.id, b.result.id);
  assert.equal(b.replayed, false);
  const otherOrg = { organizationId: randomUUID() };
  const p2 = await pricedProduct(otherOrg);
  const inputB = { items: [{ productId: p2.id, quantity: "1" }] };
  const c = await createOrderIdempotent(otherOrg, service, "r", inputB, idem("orders.create", { body: inputB }, key));
  assert.equal(c.replayed, false);
  assert.equal(await ordersIn(org.organizationId), 2);
  assert.equal(await ordersIn(otherOrg.organizationId), 1);
});

test("a failed request does not burn the key: fix the cause, retry with the same key → created once", async () => {
  const org = { organizationId: randomUUID() };
  const p = await insertProduct(org, { name: "Sem preço" });
  const input = { items: [{ productId: p.id, quantity: "1" }] };
  const key = idem("orders.create", { body: input });
  await assert.rejects(createOrderIdempotent(org, service, "r1", input, key), ProductPriceRequiredError);
  assert.equal(await ordersIn(org.organizationId), 0);
  await updateProduct(org, p.id, { price: "3.00" });
  const ok = await createOrderIdempotent(org, service, "r2", input, key);
  assert.equal(ok.replayed, false);
  assert.equal(await ordersIn(org.organizationId), 1);
});

test("no key → unchanged behaviour: two requests create two orders", async () => {
  const org = { organizationId: randomUUID() };
  const p = await pricedProduct(org);
  const input = { items: [{ productId: p.id, quantity: "1" }] };
  await createOrderIdempotent(org, service, "r", input, undefined);
  await createOrderIdempotent(org, service, "r", input, undefined);
  assert.equal(await ordersIn(org.organizationId), 2);
});

test("stock: a retried RECEIPT with the same key is counted once (sequential and 5 concurrent)", async () => {
  const org = { organizationId: randomUUID() };
  const p = await insertProduct(org, { name: "Stock", price: "1.00" });
  const input = { type: "RECEIPT" as const, quantity: "5", reason: "Fatura 123" };
  const key = idem("inventory.movements.create", { productId: p.id, body: input });
  const first = await createMovementIdempotent(org, service, "r1", p.id, input, key);
  const retry = await createMovementIdempotent(org, service, "r2", p.id, input, key);
  assert.equal(retry.replayed, true);
  assert.equal(retry.result.movement.id, first.result.movement.id);
  assert.equal((await getBalance(org, p.id))?.quantity, "5.000000");
  const key2 = idem("inventory.movements.create", { productId: p.id, body: input });
  await Promise.all(Array.from({ length: 5 }, (_, i) => createMovementIdempotent(org, service, `c${i}`, p.id, input, key2)));
  assert.equal((await getBalance(org, p.id))?.quantity, "10.000000", "5 + 5, never 5 + 25");
  const movements = await db.select({ n: count() }).from(stockMovements).where(eq(stockMovements.organizationId, org.organizationId));
  assert.equal(movements[0]!.n, 2);
});

test("customers: the same key twice → one customer, replay returns the same record", async () => {
  const org = { organizationId: randomUUID() };
  const input = { name: "Cliente Fictício", phone: "+244900000000" };
  const key = idem("customers.create", { body: input });
  const a = await createCustomerIdempotent(org, service, "r1", input, key);
  const b = await createCustomerIdempotent(org, service, "r2", input, key);
  assert.equal(b.replayed, true);
  assert.equal(b.result.id, a.result.id);
  const n = await db.select({ n: count() }).from(customers).where(eq(customers.organizationId, org.organizationId));
  assert.equal(n[0]!.n, 1);
});

test("hash: key order in the body does not change the request identity; a different value does", () => {
  assert.equal(hashRequest("orders.create", { body: { a: 1, b: [1, 2] } }), hashRequest("orders.create", { body: { b: [1, 2], a: 1 } }));
  assert.notEqual(hashRequest("orders.create", { body: { a: 1 } }), hashRequest("orders.create", { body: { a: 2 } }));
  assert.notEqual(hashRequest("orders.create", { body: { a: 1 } }), hashRequest("customers.create", { body: { a: 1 } }));
});
