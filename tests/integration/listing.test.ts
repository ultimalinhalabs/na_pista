import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { db, queryClient } from "../../src/db/index.js";
import { products } from "../../src/db/schema/index.js";
import { listBalancesPage, listMovementsPage } from "../../src/modules/inventory/service.js";
import { listInventoryQuerySchema, listMovementsQuerySchema } from "../../src/modules/inventory/schemas.js";
import { createMovement } from "../../src/modules/inventory/service.js";
import { listOrdersPage } from "../../src/modules/orders/service.js";
import { listOrdersQuerySchema } from "../../src/modules/orders/schemas.js";
import { listProductsPage } from "../../src/modules/products/service.js";
import { listProductsQuerySchema } from "../../src/modules/products/schemas.js";
import { listCustomersPage } from "../../src/modules/customers/service.js";
import { listCustomersQuerySchema } from "../../src/modules/customers/schemas.js";
import { insertCustomer, updateCustomer } from "../../src/modules/customers/repository.js";

/**
 * ADR-051/052 on real PostgreSQL, through the same service functions the
 * routes call and the same Zod schemas the routes parse with.
 */
after(() => queryClient.end());

const actor = { type: "user" as const, id: "listing-test" };
const newOrg = () => ({ organizationId: randomUUID() });

/** Rows with IDENTICAL created_at — the case a created_at-only ORDER BY cannot order deterministically. */
async function seedProducts(org: { organizationId: string }, names: string[], createdAt = new Date("2026-01-01T00:00:00Z")) {
  return db
    .insert(products)
    .values(names.map((name) => ({ organizationId: org.organizationId, name, createdAt, updatedAt: createdAt })))
    .returning();
}

const productPage = (org: { organizationId: string }, query: Record<string, string>) =>
  listProductsPage(org, listProductsQuerySchema.parse(query));

test("pages cover every row exactly once, in a deterministic order, with correct totals", async () => {
  const org = newOrg();
  const seeded = await seedProducts(org, ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  const expectedOrder = [...seeded].sort((a, b) => (a.id < b.id ? 1 : -1)).map((p) => p.id); // createdAt tie -> id desc

  const pages = [];
  for (const page of ["1", "2", "3"]) pages.push(await productPage(org, { page, pageSize: "3" }));
  assert.deepEqual(pages.map((p) => p.items.length), [3, 3, 1]);
  for (const p of pages) assert.equal(p.total, 7);
  assert.deepEqual(pages.flatMap((p) => p.items.map((i) => i.id)), expectedOrder, "union = all rows, no duplicates, id tiebreak");

  // Repeat: identical order every time.
  const again = await productPage(org, { page: "2", pageSize: "3" });
  assert.deepEqual(again.items.map((i) => i.id), pages[1]!.items.map((i) => i.id));

  // Past the end: empty data, real total.
  const beyond = await productPage(org, { page: "4", pageSize: "3" });
  assert.deepEqual(beyond.items, []);
  assert.equal(beyond.total, 7);
});

test("defaults are unchanged: no page parameters -> first 50 rows, page 1", async () => {
  const org = newOrg();
  await seedProducts(org, Array.from({ length: 55 }, (_, i) => `bulk-${i}`));
  const first = await productPage(org, {});
  assert.equal(first.page, 1);
  assert.equal(first.pageSize, 50);
  assert.equal(first.items.length, 50);
  assert.equal(first.total, 55);
});

test("`limit` is still accepted as the deprecated alias of pageSize; sending both is rejected", async () => {
  const org = newOrg();
  await seedProducts(org, ["a", "b", "c"]);
  const viaLimit = await productPage(org, { limit: "2" });
  assert.equal(viaLimit.pageSize, 2);
  assert.equal(viaLimit.items.length, 2);
  assert.equal(listProductsQuerySchema.safeParse({ limit: "2", pageSize: "2" }).success, false);
});

test("invalid page / pageSize values are rejected by the schema", () => {
  for (const bad of [{ page: "0" }, { page: "-1" }, { page: "1.5" }, { page: "abc" }, { page: "10001" }, { pageSize: "0" }, { pageSize: "101" }, { limit: "101" }]) {
    assert.equal(listProductsQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("tenant isolation: another organization's rows never appear in pages or in the total", async () => {
  const orgA = newOrg();
  const orgB = newOrg();
  const a = await seedProducts(orgA, ["a1", "a2", "a3"]);
  await seedProducts(orgB, ["b1", "b2", "b3", "b4"]);
  const page = await productPage(orgA, { pageSize: "100" });
  assert.equal(page.total, 3);
  assert.deepEqual(new Set(page.items.map((i) => i.id)), new Set(a.map((p) => p.id)));
  // Even page arithmetic cannot reach B's rows.
  assert.deepEqual((await productPage(orgA, { page: "2", pageSize: "3" })).items, []);
});

test("sorting: allowlisted fields asc/desc, ties broken by id; anything else rejected before SQL", async () => {
  const org = newOrg();
  await seedProducts(org, ["banana", "Abacate", "cenoura", "banana"]);
  const asc = await productPage(org, { sort: "name", order: "asc" });
  const desc = await productPage(org, { sort: "name", order: "desc" });
  const namesAsc = asc.items.map((i) => i.name);
  // Database collation decides letter order; the contract is: asc is ordered, desc is its exact reverse
  // (ties included — they reverse by id too), and the first/last names are the obvious ones.
  assert.equal(namesAsc[0]!.toLowerCase(), "abacate");
  assert.equal(namesAsc[namesAsc.length - 1], "cenoura");
  assert.deepEqual(desc.items.map((i) => i.id), asc.items.map((i) => i.id).reverse());
  // Equal names keep a stable id order.
  const bananasAsc = asc.items.filter((i) => i.name === "banana").map((i) => i.id);
  assert.deepEqual(bananasAsc, [...bananasAsc].sort());

  for (const bad of ["price", "id", "organizationId", "name;DROP TABLE products", "name desc", "createdAt,name", ""]) {
    assert.equal(listProductsQuerySchema.safeParse({ sort: bad }).success, false, `sort=${bad}`);
  }
  assert.equal(listProductsQuerySchema.safeParse({ order: "sideways" }).success, false);
});

test("filters: q matches % and _ literally (not as wildcards); filters combine with pagination", async () => {
  const org = newOrg();
  await seedProducts(org, ["50% desconto", "Camisola", "Calças", "item_1", "itemX1"]);
  const percent = await productPage(org, { q: "%" });
  assert.deepEqual(percent.items.map((i) => i.name), ["50% desconto"]);
  assert.equal(percent.total, 1);
  const underscore = await productPage(org, { q: "item_" });
  assert.deepEqual(underscore.items.map((i) => i.name), ["item_1"], "underscore is literal, so itemX1 does not match");

  const ca = await productPage(org, { q: "ca", pageSize: "1", sort: "name", order: "asc" });
  assert.equal(ca.total, 2, "Camisola + Calças");
  assert.equal(ca.items.length, 1);
});

test("customers: q searches name, e-mail and phone; status + q combine; totals follow the filters", async () => {
  const org = newOrg();
  await insertCustomer(org, { name: "Beatriz", email: "bia@example.com" });
  await insertCustomer(org, { name: "Carlos", phone: "923000111" });
  const archived = await insertCustomer(org, { name: "Beatriz Antiga" });
  await updateCustomer(org, archived.id, { status: "ARCHIVED" });
  const byEmail = await listCustomersPage(org, listCustomersQuerySchema.parse({ q: "bia@" }));
  assert.equal(byEmail.total, 1);
  const byPhone = await listCustomersPage(org, listCustomersQuerySchema.parse({ q: "923000" }));
  assert.equal(byPhone.items[0]?.name, "Carlos");
  const activeBeatriz = await listCustomersPage(org, listCustomersQuerySchema.parse({ q: "beatriz", status: "ACTIVE" }));
  assert.deepEqual(activeBeatriz.items.map((c) => c.name), ["Beatriz"]);
  assert.equal(activeBeatriz.total, 1);
});

test("inventory: zeroStock accepts exactly true/false (false = no filter); join-based count is tenant-scoped", async () => {
  const org = newOrg();
  const other = newOrg();
  const [stocked, empty] = await seedProducts(org, ["stocked", "empty"]);
  const [foreign] = await seedProducts(other, ["foreign"]);
  await createMovement(org, actor, undefined, stocked!.id, { type: "RECEIPT", quantity: "5" });
  await createMovement(org, actor, undefined, empty!.id, { type: "RECEIPT", quantity: "2" });
  await createMovement(org, actor, undefined, empty!.id, { type: "ADJUSTMENT_OUT", quantity: "2" });
  await createMovement(other, actor, undefined, foreign!.id, { type: "RECEIPT", quantity: "0.5" });

  const all = await listBalancesPage(org, listInventoryQuerySchema.parse({}));
  assert.equal(all.total, 2);
  const zero = await listBalancesPage(org, listInventoryQuerySchema.parse({ zeroStock: "true" }));
  assert.deepEqual(zero.items.map((b) => b.productName), ["empty"]);
  assert.equal(zero.total, 1);
  const explicitFalse = await listBalancesPage(org, listInventoryQuerySchema.parse({ zeroStock: "false" }));
  assert.equal(explicitFalse.total, 2, "zeroStock=false means no filter (it used to mean true)");
  assert.equal(listInventoryQuerySchema.safeParse({ zeroStock: "1" }).success, false);
  assert.equal(listInventoryQuerySchema.safeParse({ zeroStock: "yes" }).success, false);

  const byQuantity = await listBalancesPage(org, listInventoryQuerySchema.parse({ sort: "quantity", order: "asc" }));
  assert.deepEqual(byQuantity.items.map((b) => b.productName), ["empty", "stocked"]);
});

test("movements: paginated newest-first with a stable order and a per-product total", async () => {
  const org = newOrg();
  const [product] = await seedProducts(org, ["mov"]);
  for (let i = 0; i < 5; i++) await createMovement(org, actor, undefined, product!.id, { type: "RECEIPT", quantity: "1" });
  const p1 = await listMovementsPage(org, product!.id, listMovementsQuerySchema.parse({ pageSize: "2" }));
  const p2 = await listMovementsPage(org, product!.id, listMovementsQuerySchema.parse({ pageSize: "2", page: "2" }));
  const p3 = await listMovementsPage(org, product!.id, listMovementsQuerySchema.parse({ pageSize: "2", page: "3" }));
  assert.equal(p1.total, 5);
  const ids = [...p1.items, ...p2.items, ...p3.items].map((m) => m.id);
  assert.equal(new Set(ids).size, 5, "no duplicates across pages");
});

test("orders: status filter + pagination; sort by updatedAt allowed, by total rejected", async () => {
  const org = newOrg();
  assert.equal((await listOrdersPage(org, listOrdersQuerySchema.parse({}))).total, 0);
  assert.equal(listOrdersQuerySchema.safeParse({ sort: "updatedAt", order: "asc" }).success, true);
  assert.equal(listOrdersQuerySchema.safeParse({ sort: "total" }).success, false);
});
