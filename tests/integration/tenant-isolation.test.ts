import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { queryClient } from "../../src/db/index.js";
import { insertCategory } from "../../src/modules/categories/repository.js";
import { getProduct, insertProduct, listProducts } from "../../src/modules/products/repository.js";

/**
 * F20 brief §12/§28 "Integration": repository + real PostgreSQL, no HTTP,
 * no Platform involved — proves the database layer itself (composite FK,
 * tenant-scoped queries) independent of the auth/entitlement pipeline.
 */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };

after(() => queryClient.end());

test("a product created for org A is never visible from org B's tenant-scoped query", async () => {
  const product = await insertProduct(orgA, { name: "Product A" });
  const listB = await listProducts(orgB, { limit: 50 });
  assert.ok(!listB.some((p) => p.id === product.id));

  const fetchedFromB = await getProduct(orgB, product.id);
  assert.equal(fetchedFromB, undefined);

  const fetchedFromA = await getProduct(orgA, product.id);
  assert.equal(fetchedFromA?.id, product.id);
});

test("composite FK: a product cannot reference a category from a different organization", async () => {
  const categoryB = await insertCategory(orgB, { name: "Category B" });

  await assert.rejects(() => insertProduct(orgA, { name: "Cross-tenant product", categoryId: categoryB.id }));
});

test("a product CAN reference a category from its own organization", async () => {
  const categoryA = await insertCategory(orgA, { name: "Category A2" });
  const product = await insertProduct(orgA, { name: "Product with own category", categoryId: categoryA.id });
  assert.equal(product.categoryId, categoryA.id);
});
