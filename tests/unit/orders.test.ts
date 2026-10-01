import assert from "node:assert/strict";
import test from "node:test";
import { addOrderItemSchema, createOrderSchema, listOrdersQuerySchema, updateOrderItemSchema, updateOrderSchema } from "../../src/modules/orders/schemas.js";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import { pageRequest } from "../../src/shared/listing.js";

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";

/** F23 brief §13/§14/§33: a client can never inject price/total/currency/productName — none of these are even valid fields in the schema. */
test("createOrderSchema: rejects protected/server-derived fields (unitPrice, subtotal, total, currency, organizationId, productName, status)", () => {
  const base = { items: [{ productId: PRODUCT_ID, quantity: 1 }] };
  for (const field of ["unitPrice", "subtotal", "total", "currency", "organizationId", "productName", "status", "id", "createdAt"]) {
    const result = createOrderSchema.safeParse({ ...base, [field]: "anything" });
    assert.equal(result.success, false, `expected ${field} to be rejected`);
  }
  for (const field of ["unitPrice", "subtotal", "total"]) {
    const result = createOrderSchema.safeParse({ items: [{ productId: PRODUCT_ID, quantity: 1, [field]: "0.01" }] });
    assert.equal(result.success, false, `expected item-level ${field} to be rejected`);
  }
});

test("createOrderSchema: customerId optional, items default to an empty array", () => {
  const empty = createOrderSchema.safeParse({});
  assert.equal(empty.success, true);
  if (empty.success) assert.deepEqual(empty.data.items, []);

  const withCustomer = createOrderSchema.safeParse({ customerId: CUSTOMER_ID });
  assert.equal(withCustomer.success, true);

  const badCustomer = createOrderSchema.safeParse({ customerId: "not-a-uuid" });
  assert.equal(badCustomer.success, false);
});

test("createOrderSchema: items[].quantity reuses the inventory quantity model — rejects zero/negative/NaN, normalizes to a 6-decimal string", () => {
  const zero = createOrderSchema.safeParse({ items: [{ productId: PRODUCT_ID, quantity: 0 }] });
  assert.equal(zero.success, false);

  const negative = createOrderSchema.safeParse({ items: [{ productId: PRODUCT_ID, quantity: -1 }] });
  assert.equal(negative.success, false);

  const fractional = createOrderSchema.safeParse({ items: [{ productId: PRODUCT_ID, quantity: 0.75 }] });
  assert.equal(fractional.success, true);
  if (fractional.success) assert.equal(fractional.data.items[0]!.quantity, "0.750000");
});

test("createOrderSchema: items[].productId must be a uuid", () => {
  const result = createOrderSchema.safeParse({ items: [{ productId: "not-a-uuid", quantity: 1 }] });
  assert.equal(result.success, false);
});

test("addOrderItemSchema: requires productId and quantity, rejects unknown fields", () => {
  assert.equal(addOrderItemSchema.safeParse({ productId: PRODUCT_ID, quantity: 1 }).success, true);
  assert.equal(addOrderItemSchema.safeParse({ productId: PRODUCT_ID }).success, false);
  assert.equal(addOrderItemSchema.safeParse({ productId: PRODUCT_ID, quantity: 1, unitPrice: "1.00" }).success, false);
});

test("updateOrderItemSchema: quantity only, rejects zero/negative", () => {
  assert.equal(updateOrderItemSchema.safeParse({ quantity: 2 }).success, true);
  assert.equal(updateOrderItemSchema.safeParse({ quantity: 0 }).success, false);
  assert.equal(updateOrderItemSchema.safeParse({}).success, false);
});

test("updateOrderSchema: customerId nullable (clears the association) and optional (leaves it untouched)", () => {
  assert.equal(updateOrderSchema.safeParse({}).success, true);
  assert.equal(updateOrderSchema.safeParse({ customerId: null }).success, true);
  assert.equal(updateOrderSchema.safeParse({ customerId: CUSTOMER_ID }).success, true);
  assert.equal(updateOrderSchema.safeParse({ customerId: "not-a-uuid" }).success, false);
});

test("listOrdersQuerySchema: status/customerId/limit bounds", () => {
  assert.equal(listOrdersQuerySchema.safeParse({ status: "DRAFT" }).success, true);
  assert.equal(listOrdersQuerySchema.safeParse({ status: "SHIPPED" }).success, false);
  assert.equal(listOrdersQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(listOrdersQuerySchema.safeParse({ limit: 101 }).success, false);
  const defaults = listOrdersQuerySchema.safeParse({});
  assert.equal(defaults.success, true);
  // ADR-051: the default page size (still 50) is applied by pageRequest(), not by the schema.
  if (defaults.success) assert.equal(pageRequest(defaults.data, 50).pageSize, 50);
});

/** F23 brief §27: orders.create gates POST /orders; orders.update gates every other mutation (items, customer PATCH, lifecycle) — deliberately not split further. */
test("permission mapping: STAFF can read orders but has no mutation permission at all", () => {
  assert.equal(roleHasPermission("STAFF", "orders.read"), true);
  assert.equal(roleHasPermission("STAFF", "orders.create"), false);
  assert.equal(roleHasPermission("STAFF", "orders.update"), false);
});

test("permission mapping: MANAGER can create and update Orders (including lifecycle transitions)", () => {
  assert.equal(roleHasPermission("MANAGER", "orders.create"), true);
  assert.equal(roleHasPermission("MANAGER", "orders.update"), true);
});

test("permission mapping: OWNER/ADMIN have full order management", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    assert.equal(roleHasPermission(role, "orders.read"), true);
    assert.equal(roleHasPermission(role, "orders.create"), true);
    assert.equal(roleHasPermission(role, "orders.update"), true);
  }
});

test("permission mapping: orders.delete does not exist for any role — Orders are never physically deleted, cancellation is a lifecycle transition (F23 brief §24/§27)", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER", "STAFF"]) {
    assert.equal(roleHasPermission(role, "orders.delete"), false);
  }
});
