import assert from "node:assert/strict";
import test from "node:test";
import { createMovementSchema, listInventoryQuerySchema } from "../../src/modules/inventory/schemas.js";
import { roleHasPermission } from "../../src/authorization/permissions.js";

/** F22 brief §4/§29: quantity validation and normalization. */
test("createMovementSchema: rejects zero, negative, NaN, Infinity", () => {
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: 0 }).success, false);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: -5 }).success, false);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: NaN }).success, false);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: Infinity }).success, false);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: "not-a-number" }).success, false);
});

test("createMovementSchema: accepts a positive number or decimal string and normalizes to a fixed 6-decimal string", () => {
  const r1 = createMovementSchema.safeParse({ type: "RECEIPT", quantity: 10 });
  assert.equal(r1.success, true);
  if (r1.success) assert.equal(r1.data.quantity, "10.000000");

  const r2 = createMovementSchema.safeParse({ type: "RECEIPT", quantity: "2.5" });
  assert.equal(r2.success, true);
  if (r2.success) assert.equal(r2.data.quantity, "2.500000");

  const r3 = createMovementSchema.safeParse({ type: "RECEIPT", quantity: 0.000001 });
  assert.equal(r3.success, true);
});

test("createMovementSchema: rejects a quantity beyond numeric(20,6)'s representable range", () => {
  const result = createMovementSchema.safeParse({ type: "RECEIPT", quantity: 1e15 });
  assert.equal(result.success, false);
});

test("createMovementSchema: rejects an unknown movement type", () => {
  assert.equal(createMovementSchema.safeParse({ type: "SALE", quantity: 1 }).success, false);
});

test("createMovementSchema: rejects protected/unknown fields", () => {
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: 1, id: "x" }).success, false);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: 1, organizationId: "x" }).success, false);
});

test("createMovementSchema: reason is optional and length-bounded", () => {
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: 1 }).success, true);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: 1, reason: "Initial stock" }).success, true);
  assert.equal(createMovementSchema.safeParse({ type: "RECEIPT", quantity: 1, reason: "x".repeat(501) }).success, false);
});

test("listInventoryQuerySchema: zeroStock accepted, lowStock NOT a recognized field (F22 brief §16 — no threshold concept exists)", () => {
  assert.equal(listInventoryQuerySchema.safeParse({ zeroStock: "true" }).success, true);
  assert.equal(listInventoryQuerySchema.safeParse({ lowStock: "true" }).success, false);
});

/** F22 brief §19: permission mapping — inventory.create (RECEIPT) vs inventory.update (adjustments), no inventory.delete anywhere. */
test("permission mapping: STAFF can read inventory but has no mutation permission at all", () => {
  assert.equal(roleHasPermission("STAFF", "inventory.read"), true);
  assert.equal(roleHasPermission("STAFF", "inventory.create"), false);
  assert.equal(roleHasPermission("STAFF", "inventory.update"), false);
});

test("permission mapping: MANAGER can create and update inventory (receive stock, adjust)", () => {
  assert.equal(roleHasPermission("MANAGER", "inventory.create"), true);
  assert.equal(roleHasPermission("MANAGER", "inventory.update"), true);
});

test("permission mapping: OWNER/ADMIN have full inventory management", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    assert.equal(roleHasPermission(role, "inventory.read"), true);
    assert.equal(roleHasPermission(role, "inventory.create"), true);
    assert.equal(roleHasPermission(role, "inventory.update"), true);
  }
});

test("permission mapping: inventory.delete does not exist for any role — no lifecycle operation to delete (F22 brief §19)", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER", "STAFF"]) {
    assert.equal(roleHasPermission(role, "inventory.delete"), false);
  }
});
