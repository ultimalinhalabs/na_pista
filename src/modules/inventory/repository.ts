import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { inventoryBalances, products, stockMovements } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: requires a TenantContext, same pattern as every other Na Pista module. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select" | "update">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export interface BalanceRow {
  id: string;
  organizationId: string;
  productId: string;
  quantity: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BalanceWithProduct extends BalanceRow {
  productName: string;
  productUnit: string;
  productStatus: "ACTIVE" | "ARCHIVED";
}

export async function listBalances(
  tenant: TenantContext,
  filters: { zeroStock?: boolean; limit: number },
  executor: Executor = db,
): Promise<BalanceWithProduct[]> {
  assertTenant(tenant);
  const conditions = [eq(inventoryBalances.organizationId, tenant.organizationId)];
  if (filters.zeroStock) conditions.push(eq(inventoryBalances.quantity, "0"));
  const rows = await executor
    .select({
      id: inventoryBalances.id,
      organizationId: inventoryBalances.organizationId,
      productId: inventoryBalances.productId,
      quantity: inventoryBalances.quantity,
      createdAt: inventoryBalances.createdAt,
      updatedAt: inventoryBalances.updatedAt,
      productName: products.name,
      productUnit: products.unit,
      productStatus: products.status,
    })
    .from(inventoryBalances)
    .innerJoin(products, and(eq(products.organizationId, inventoryBalances.organizationId), eq(products.id, inventoryBalances.productId)))
    .where(and(...conditions))
    .orderBy(desc(inventoryBalances.updatedAt))
    .limit(filters.limit);
  return rows as BalanceWithProduct[];
}

export async function getBalance(tenant: TenantContext, productId: string, executor: Executor = db): Promise<BalanceWithProduct | undefined> {
  assertTenant(tenant);
  const [row] = await executor
    .select({
      id: inventoryBalances.id,
      organizationId: inventoryBalances.organizationId,
      productId: inventoryBalances.productId,
      quantity: inventoryBalances.quantity,
      createdAt: inventoryBalances.createdAt,
      updatedAt: inventoryBalances.updatedAt,
      productName: products.name,
      productUnit: products.unit,
      productStatus: products.status,
    })
    .from(inventoryBalances)
    .innerJoin(products, and(eq(products.organizationId, inventoryBalances.organizationId), eq(products.id, inventoryBalances.productId)))
    .where(and(eq(inventoryBalances.organizationId, tenant.organizationId), eq(inventoryBalances.productId, productId)))
    .limit(1);
  return row as BalanceWithProduct | undefined;
}

/**
 * ADR-028: atomic, race-safe increase. A single `INSERT ... ON CONFLICT
 * DO UPDATE` — creates the balance on the first RECEIPT (F22 brief §14)
 * or increments it if one already exists, in one statement. Postgres
 * itself serializes concurrent writers to the same (organization,
 * product) row via the unique index this upsert targets — no
 * application-level locking needed.
 */
export async function increaseBalance(tenant: TenantContext, productId: string, deltaDecimalString: string, executor: Executor = db): Promise<BalanceRow> {
  assertTenant(tenant);
  const [row] = await executor
    .insert(inventoryBalances)
    .values({ organizationId: tenant.organizationId, productId, quantity: deltaDecimalString })
    .onConflictDoUpdate({
      target: [inventoryBalances.organizationId, inventoryBalances.productId],
      set: {
        quantity: sql`${inventoryBalances.quantity} + ${deltaDecimalString}::numeric`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row! as BalanceRow;
}

/**
 * ADR-028: atomic, race-safe decrease. The `WHERE quantity >= $delta`
 * guard is evaluated as part of the SAME row-locking UPDATE — there is
 * no separate "read, check in JS, then write" step for a concurrent
 * writer to interleave with (the classic lost-update race). If the
 * guard fails (insufficient stock, including "no balance row at all",
 * which behaves as zero), zero rows are affected and this returns
 * `undefined` — the caller decides that's `InsufficientStockError`,
 * never a Postgres error to translate.
 */
export async function decreaseBalance(tenant: TenantContext, productId: string, deltaDecimalString: string, executor: Executor = db): Promise<BalanceRow | undefined> {
  assertTenant(tenant);
  const [row] = await executor
    .update(inventoryBalances)
    .set({
      quantity: sql`${inventoryBalances.quantity} - ${deltaDecimalString}::numeric`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(inventoryBalances.organizationId, tenant.organizationId),
        eq(inventoryBalances.productId, productId),
        sql`${inventoryBalances.quantity} >= ${deltaDecimalString}::numeric`,
      ),
    )
    .returning();
  return row as BalanceRow | undefined;
}

export interface MovementRow {
  id: string;
  organizationId: string;
  inventoryId: string;
  productId: string;
  type: "RECEIPT" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT";
  quantity: string;
  reason: string | null;
  actorType: "user" | "service";
  actorId: string;
  createdAt: Date;
}

export async function insertMovement(
  tenant: TenantContext,
  input: {
    inventoryId: string;
    productId: string;
    type: "RECEIPT" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT";
    quantity: string;
    reason?: string;
    actorType: "user" | "service";
    actorId: string;
  },
  executor: Executor = db,
): Promise<MovementRow> {
  assertTenant(tenant);
  const [row] = await executor
    .insert(stockMovements)
    .values({ organizationId: tenant.organizationId, ...input })
    .returning();
  return row! as MovementRow;
}

export async function listMovements(tenant: TenantContext, productId: string, filters: { limit: number }, executor: Executor = db): Promise<MovementRow[]> {
  assertTenant(tenant);
  const rows = await executor
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.organizationId, tenant.organizationId), eq(stockMovements.productId, productId)))
    .orderBy(desc(stockMovements.createdAt))
    .limit(filters.limit);
  return rows as MovementRow[];
}
