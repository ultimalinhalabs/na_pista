import assert from "node:assert/strict";
import test from "node:test";
import * as categoryRepo from "../../src/modules/categories/repository.js";
import * as productRepo from "../../src/modules/products/repository.js";

/**
 * F20 brief §13/§36: a repository function must never run without a
 * TenantContext, for BOTH modules. Synchronous guard, no DB connection needed.
 */
test("category repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => categoryRepo.insertCategory(undefined, { name: "x" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => categoryRepo.listCategories(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => categoryRepo.getCategory({}, "id"), /TenantContext/);
  await assert.rejects(() => categoryRepo.updateCategory({ organizationId: "" }, "id", {}), /TenantContext/);
});

test("product repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => productRepo.insertProduct(undefined, { name: "x" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => productRepo.listProducts(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => productRepo.getProduct({}, "id"), /TenantContext/);
  await assert.rejects(() => productRepo.updateProduct({ organizationId: "" }, "id", {}), /TenantContext/);
});
