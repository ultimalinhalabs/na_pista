import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { inventoryBalances, stockMovements } from "../../src/db/schema/index.js";
import { insertProduct, updateProduct } from "../../src/modules/products/repository.js";
import { createMovement, getBalanceOrThrow, listAllBalances, listAllMovements } from "../../src/modules/inventory/service.js";
import { getBalance } from "../../src/modules/inventory/repository.js";
import { InsufficientStockError, InventoryNotFoundError, ProductArchivedError, ProductNotFoundError } from "../../src/shared/errors.js";

/** F22 brief §31 "Integration tests", real PostgreSQL, no HTTP, no Platform. */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };
const actor = { type: "user" as const, id: "test-actor" };

after(() => queryClient.end());

test("RECEIPT on a never-stocked product creates the balance lazily (F22 brief §14) and a movement row", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Azul" });

  const before = await getBalance(orgA, product.id);
  assert.equal(before, undefined, "no balance row exists before the first RECEIPT");

  const { balance, movement } = await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "10.000000" });
  assert.equal(balance.quantity, "10.000000");
  assert.equal(movement.type, "RECEIPT");
  assert.equal(movement.inventoryId, balance.id);

  const movements = await listAllMovements(orgA, product.id, { limit: 10 });
  assert.equal(movements.length, 1);
});

test("ADJUSTMENT_IN increases an existing balance", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Verde" });
  await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "5.000000" });
  const { balance } = await createMovement(orgA, actor, "req-2", product.id, { type: "ADJUSTMENT_IN", quantity: "3.000000" });
  assert.equal(balance.quantity, "8.000000");
});

test("ADJUSTMENT_OUT decreases an existing balance when stock is sufficient", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Preta" });
  await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "10.000000" });
  const { balance } = await createMovement(orgA, actor, "req-2", product.id, { type: "ADJUSTMENT_OUT", quantity: "4.000000" });
  assert.equal(balance.quantity, "6.000000");
});

test("ADJUSTMENT_OUT beyond available stock fails atomically with INSUFFICIENT_STOCK, balance and movement count unchanged", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Branca" });
  await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "5.000000" });

  await assert.rejects(() => createMovement(orgA, actor, "req-2", product.id, { type: "ADJUSTMENT_OUT", quantity: "6.000000" }), InsufficientStockError);

  const balance = await getBalance(orgA, product.id);
  assert.equal(balance?.quantity, "5.000000", "balance must be untouched after a failed decrease");
  const movements = await listAllMovements(orgA, product.id, { limit: 10 });
  assert.equal(movements.length, 1, "no orphaned movement row from the failed attempt");
});

test("ADJUSTMENT_OUT against a product with no balance at all also fails with INSUFFICIENT_STOCK (ADR-028)", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Nunca Recebida" });
  await assert.rejects(() => createMovement(orgA, actor, "req-1", product.id, { type: "ADJUSTMENT_OUT", quantity: "1.000000" }), InsufficientStockError);
  const balance = await getBalance(orgA, product.id);
  assert.equal(balance, undefined, "still no balance row created by a failed decrease");
});

test("createMovement against a nonexistent product throws PRODUCT_NOT_FOUND, not a raw FK violation", async () => {
  await assert.rejects(() => createMovement(orgA, actor, "req-1", randomUUID(), { type: "RECEIPT", quantity: "1.000000" }), ProductNotFoundError);
});

test("createMovement against an ARCHIVED product is rejected, but its existing balance/history remain fully readable (F22 brief §22)", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Descontinuada" });
  await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "7.000000" });
  await updateProduct(orgA, product.id, { status: "ARCHIVED" });

  await assert.rejects(() => createMovement(orgA, actor, "req-2", product.id, { type: "ADJUSTMENT_IN", quantity: "1.000000" }), ProductArchivedError);

  const balance = await getBalanceOrThrow(orgA, product.id);
  assert.equal(balance.quantity, "7.000000", "archived product's balance is untouched, and still readable");
  const movements = await listAllMovements(orgA, product.id, { limit: 10 });
  assert.equal(movements.length, 1, "history is preserved, no new movement was inserted");
});

test("getBalanceOrThrow distinguishes PRODUCT_NOT_FOUND from INVENTORY_NOT_FOUND (F22 brief §30)", async () => {
  await assert.rejects(() => getBalanceOrThrow(orgA, randomUUID()), ProductNotFoundError);

  const neverStocked = await insertProduct(orgA, { name: "Camisola Sem Stock Ainda" });
  await assert.rejects(() => getBalanceOrThrow(orgA, neverStocked.id), InventoryNotFoundError);
});

test("a balance/movement created for org A is never visible from org B's tenant-scoped query (composite FK + repository guard)", async () => {
  const product = await insertProduct(orgA, { name: "Isolation Probe" });
  await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "9.000000" });

  const listB = await listAllBalances(orgB, { limit: 100 });
  assert.ok(!listB.some((b) => b.productId === product.id));
  assert.equal(await getBalance(orgB, product.id), undefined);

  // Org B cannot even reference org A's product — getProduct() is tenant-scoped inside createMovement.
  await assert.rejects(() => createMovement(orgB, actor, "req-2", product.id, { type: "RECEIPT", quantity: "1.000000" }), ProductNotFoundError);
});

test("zeroStock filter returns only balances at exactly zero", async () => {
  const org = { organizationId: randomUUID() };
  const zero = await insertProduct(org, { name: "Zero Stock Item" });
  const nonZero = await insertProduct(org, { name: "Has Stock Item" });
  await createMovement(org, actor, "req-1", zero.id, { type: "RECEIPT", quantity: "5.000000" });
  await createMovement(org, actor, "req-2", zero.id, { type: "ADJUSTMENT_OUT", quantity: "5.000000" });
  await createMovement(org, actor, "req-3", nonZero.id, { type: "RECEIPT", quantity: "3.000000" });

  const zeroOnly = await listAllBalances(org, { zeroStock: true, limit: 50 });
  assert.ok(zeroOnly.some((b) => b.productId === zero.id));
  assert.ok(!zeroOnly.some((b) => b.productId === nonZero.id));
});

test("audit failure inside the same transaction rolls back BOTH the movement and the balance change (ADR-028, real Postgres rollback proof)", async () => {
  const product = await insertProduct(orgA, { name: "Camisola Rollback" });
  await createMovement(orgA, actor, "req-1", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const { recordAuditEvent } = await import("../../src/modules/audit/service.js");
  const { increaseBalance, insertMovement } = await import("../../src/modules/inventory/repository.js");

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        const balance = await increaseBalance(orgA, product.id, "2.000000", tx);
        const movement = await insertMovement(
          orgA,
          { inventoryId: balance.id, productId: product.id, type: "ADJUSTMENT_IN", quantity: "2.000000", actorType: "user", actorId: "test-actor" },
          tx,
        );
        // Force a real Postgres NOT NULL violation on the audit insert.
        await recordAuditEvent(
          {
            organizationId: orgA.organizationId,
            actorType: "user",
            actorId: "test-actor",
            // @ts-expect-error deliberately violating the NOT NULL constraint to prove rollback
            action: null,
            resourceType: "inventory_movement",
            resourceId: movement.id,
          },
          tx,
        );
      }),
    /audit_events/i,
  );

  const balanceAfter = await getBalance(orgA, product.id);
  assert.equal(balanceAfter?.quantity, "10.000000", "the balance increase must not have persisted after rollback");
  const movementsAfter = await listAllMovements(orgA, product.id, { limit: 10 });
  assert.equal(movementsAfter.length, 1, "only the original RECEIPT movement exists — the rolled-back ADJUSTMENT_IN movement must not persist");
});

// drizzle-orm wraps the driver's real Postgres error as `.cause` and its own
// outer message is just "Failed query: ...", so assertions must inspect the
// cause — same pattern ul-platform's own tests use for raw constraint proofs.
function causeMessage(error: unknown): string {
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error);
}

test("composite FK rejects an inventory_balances row pointing at a product from a different organization", async () => {
  const productInA = await insertProduct(orgA, { name: "Cross-tenant Target" });
  const err = await db
    .insert(inventoryBalances)
    .values({ organizationId: orgB.organizationId, productId: productInA.id, quantity: "1.000000" })
    .catch((e) => e);
  assert.ok(err instanceof Error, "insert must fail");
  assert.match(causeMessage(err), /foreign key|violat/i);
  assert.match(causeMessage(err), /inventory_balances_product_org_fk/);
});

test("composite FK rejects a stock_movements row pointing at a product from a different organization", async () => {
  const productInA = await insertProduct(orgA, { name: "Cross-tenant Movement Target" });
  const { balance } = await createMovement(orgA, actor, "req-1", productInA.id, { type: "RECEIPT", quantity: "1.000000" });
  const err = await db
    .insert(stockMovements)
    .values({
      organizationId: orgB.organizationId,
      inventoryId: balance.id,
      productId: productInA.id,
      type: "RECEIPT",
      quantity: "1.000000",
      actorType: "user",
      actorId: "test-actor",
    })
    .catch((e) => e);
  assert.ok(err instanceof Error, "insert must fail");
  assert.match(causeMessage(err), /foreign key|violat/i);
  assert.match(causeMessage(err), /stock_movements_product_org_fk/);
});

test("CHECK constraint defense-in-depth: a direct negative quantity insert into inventory_balances is rejected", async () => {
  const product = await insertProduct(orgA, { name: "Negative Probe" });
  const err = await db
    .insert(inventoryBalances)
    .values({ organizationId: orgA.organizationId, productId: product.id, quantity: "-1.000000" })
    .catch((e) => e);
  assert.ok(err instanceof Error, "insert must fail");
  assert.match(causeMessage(err), /check|violat/i);
  assert.match(causeMessage(err), /inventory_balances_quantity_non_negative/);
});

/**
 * F22 brief §32 — MANDATORY concurrency proof, not assertion.
 * Initial stock = 10. Fire many concurrent ADJUSTMENT_OUT = 7 requests
 * (via real, independently-opened `db.transaction` calls racing on the
 * real Postgres connection pool — genuinely concurrent, not sequential
 * awaits). Only one can possibly succeed (10 - 7 = 3, and a second -7
 * would go negative). Expected: exactly one succeeds, the rest fail with
 * INSUFFICIENT_STOCK, final balance = 3, never negative, never double-applied.
 */
test("CONCURRENCY: two simultaneous ADJUSTMENT_OUT=7 against a balance of 10 — exactly one succeeds, final balance = 3 (F22 brief §32)", async () => {
  const product = await insertProduct(orgA, { name: "Concurrency Probe" });
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const attempts = await Promise.allSettled([
    createMovement(orgA, actor, "req-a", product.id, { type: "ADJUSTMENT_OUT", quantity: "7.000000" }),
    createMovement(orgA, actor, "req-b", product.id, { type: "ADJUSTMENT_OUT", quantity: "7.000000" }),
  ]);

  const fulfilled = attempts.filter((r) => r.status === "fulfilled");
  const rejected = attempts.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one of the two concurrent decreases must succeed");
  assert.equal(rejected.length, 1, "exactly one must fail");
  assert.ok(
    (rejected[0] as PromiseRejectedResult).reason instanceof InsufficientStockError,
    "the loser must fail specifically with INSUFFICIENT_STOCK, not a generic/DB error",
  );

  const finalBalance = await getBalance(orgA, product.id);
  assert.equal(finalBalance?.quantity, "3.000000", "final balance must be exactly 3 — never negative, never a lost update, never double-applied");

  const movements = await listAllMovements(orgA, product.id, { limit: 10 });
  const outMovements = movements.filter((m) => m.type === "ADJUSTMENT_OUT");
  assert.equal(outMovements.length, 1, "exactly one ADJUSTMENT_OUT movement row must exist — the loser must never have inserted a movement");
});

/** A wider fan-out of the same invariant: 5 concurrent ADJUSTMENT_OUT=3 against a balance of 10 — exactly 3 can succeed (9 consumed), 2 must fail, final balance = 1. */
test("CONCURRENCY: five simultaneous ADJUSTMENT_OUT=3 against a balance of 10 — exactly 3 succeed, final balance = 1", async () => {
  const product = await insertProduct(orgA, { name: "Concurrency Probe Wide" });
  await createMovement(orgA, actor, "req-seed", product.id, { type: "RECEIPT", quantity: "10.000000" });

  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, (_, i) => createMovement(orgA, actor, `req-wide-${i}`, product.id, { type: "ADJUSTMENT_OUT", quantity: "3.000000" })),
  );

  const fulfilled = attempts.filter((r) => r.status === "fulfilled");
  const rejected = attempts.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 3, "exactly 3 of 5 concurrent -3 decreases can fit in a balance of 10");
  assert.equal(rejected.length, 2);
  for (const r of rejected) {
    assert.ok((r as PromiseRejectedResult).reason instanceof InsufficientStockError);
  }

  const finalBalance = await getBalance(orgA, product.id);
  assert.equal(finalBalance?.quantity, "1.000000", "10 - 3*3 = 1, exactly");
});

test("cleanup: no stray rows leak scope (sanity check on tenant-scoped listAllBalances limit)", async () => {
  const rows = await listAllBalances(orgA, { limit: 200 });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.organizationId === orgA.organizationId));
});
