import assert from "node:assert/strict";
import test from "node:test";
import { getProduct, insertProduct, listProducts, countActiveProducts } from "../../src/modules/products/repository.js";

/**
 * F19 §19 "Repository receives missing tenant context" — must fail hard,
 * synchronously, before any query is attempted. No DB connection needed
 * for this: the guard runs before the first `await`.
 */
test("repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => insertProduct(undefined, { name: "x" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => listProducts(null), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => getProduct({}, "id"), /TenantContext/);
  // Type-valid (empty string is still a `string`) but runtime-invalid — exactly the case the guard exists for.
  await assert.rejects(() => countActiveProducts({ organizationId: "" }), /TenantContext/);
});
