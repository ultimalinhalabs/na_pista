import assert from "node:assert/strict";
import test from "node:test";
import { createProductSchema, updateProductSchema } from "../../src/modules/products/schemas.js";
import { createCategorySchema } from "../../src/modules/categories/schemas.js";

/** F20 brief §16: reject unknown fields, never let the client determine tenant via the body. */
test("createProductSchema rejects an unknown field (e.g. a client-supplied organizationId)", () => {
  const result = createProductSchema.safeParse({ name: "Iogurte", organizationId: "11111111-1111-1111-1111-111111111111" });
  assert.equal(result.success, false);
});

test("createProductSchema rejects client-supplied id/createdAt/updatedAt", () => {
  const result = createProductSchema.safeParse({ name: "x", id: "y", createdAt: "2020-01-01" });
  assert.equal(result.success, false);
});

test("createProductSchema requires a non-empty name", () => {
  assert.equal(createProductSchema.safeParse({ name: "" }).success, false);
  assert.equal(createProductSchema.safeParse({}).success, false);
});

test("createProductSchema rejects a non-uuid categoryId", () => {
  assert.equal(createProductSchema.safeParse({ name: "x", categoryId: "not-a-uuid" }).success, false);
});

test("updateProductSchema allows clearing categoryId to null explicitly", () => {
  const result = updateProductSchema.safeParse({ categoryId: null });
  assert.equal(result.success, true);
});

/** F23 (ADR-029/ADR-031): price is money — never a float, normalized to a fixed 2-decimal string. */
test("createProductSchema: price accepts a number or decimal string, normalizes to 2 decimals, rejects negative/NaN/Infinity", () => {
  const r1 = createProductSchema.safeParse({ name: "Camisola", price: 10000 });
  assert.equal(r1.success, true);
  if (r1.success) assert.equal(r1.data.price, "10000.00");

  const r2 = createProductSchema.safeParse({ name: "Camisola", price: "12000.5" });
  assert.equal(r2.success, true);
  if (r2.success) assert.equal(r2.data.price, "12000.50");

  assert.equal(createProductSchema.safeParse({ name: "Camisola", price: -1 }).success, false);
  assert.equal(createProductSchema.safeParse({ name: "Camisola", price: NaN }).success, false);
  assert.equal(createProductSchema.safeParse({ name: "Camisola", price: Infinity }).success, false);
});

test("createProductSchema: price is optional — a Product can be created without one (F20/F21/F22 migration compatibility)", () => {
  const result = createProductSchema.safeParse({ name: "Camisola" });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.price, undefined);
});

test("createProductSchema: price = 0 is explicitly valid (a deliberately free/promotional product)", () => {
  const result = createProductSchema.safeParse({ name: "Amostra Grátis", price: 0 });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.price, "0.00");
});

test("updateProductSchema: price can be explicitly cleared back to null (\"not yet priced\")", () => {
  const result = updateProductSchema.safeParse({ price: null });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.price, null);
});

test("createCategorySchema trims and requires a name", () => {
  assert.equal(createCategorySchema.safeParse({ name: "   " }).success, false);
  const result = createCategorySchema.safeParse({ name: "  Bebidas  " });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.name, "Bebidas");
});
