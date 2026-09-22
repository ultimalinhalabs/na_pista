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

test("createCategorySchema trims and requires a name", () => {
  assert.equal(createCategorySchema.safeParse({ name: "   " }).success, false);
  const result = createCategorySchema.safeParse({ name: "  Bebidas  " });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.name, "Bebidas");
});
