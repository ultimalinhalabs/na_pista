import { check, foreignKey, index, numeric, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";
import { products } from "./products.js";
import { timestamps } from "./_helpers.js";

/**
 * ADR-027: one current balance per (organization, product) — no
 * warehouses/locations in this slice (OD-06, closed: deferred, not
 * needed by any demonstrated requirement yet). `quantity numeric(20,6)`
 * — precise decimal, never a JS/Postgres float (F22 brief §4); never
 * negative, enforced at the database level (CHECK), not only in
 * application code (F22 brief §33).
 *
 * No row is created when a Product is created (F22 brief §14) — a
 * balance only exists once a RECEIPT has happened. Avoids unnecessary
 * rows for products that have never been stocked.
 */
export const inventoryBalances = naPistaSchema.table(
  "inventory_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    productId: uuid("product_id").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull().default("0"),
    ...timestamps,
  },
  (table) => [
    // The core F22 invariant: at most one balance per organization+product.
    uniqueIndex("inventory_balances_org_product_unique").on(table.organizationId, table.productId),
    // Composite-FK target for stock_movements below.
    uniqueIndex("inventory_balances_org_id_unique").on(table.organizationId, table.id),
    index("inventory_balances_org_updated_idx").on(table.organizationId, table.updatedAt),
    // Tenant-safe product reference — same composite-FK pattern ADR-021
    // already established for products -> categories.
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "inventory_balances_product_org_fk",
    }),
    // Database-level reinforcement of "stock can never go negative"
    // (F22 brief §6/§33) — the application's conditional UPDATE (never
    // negative by construction) is the primary mechanism; this is
    // defense in depth against any future write path that forgets it.
    check("inventory_balances_quantity_non_negative", sql`${table.quantity} >= 0`),
  ],
);

/**
 * ADR-028: the movement ledger — append-only, never updated/deleted.
 * `quantity` is always POSITIVE; `type` determines direction (F22 brief
 * §11) — never a signed input, which would make the API ambiguous.
 * `inventoryId` + `productId` are both stored (the balance a movement
 * belongs to, and the product it concerns) so movement history queries
 * never need to join through inventory_balances just to filter by
 * product — matches the real query shape this module needs.
 */
export const stockMovements = naPistaSchema.table(
  "stock_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    inventoryId: uuid("inventory_id").notNull(),
    productId: uuid("product_id").notNull(),
    type: text("type", { enum: ["RECEIPT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"] }).notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    reason: text("reason"),
    actorType: text("actor_type", { enum: ["user", "service"] }).notNull(),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("stock_movements_org_product_created_idx").on(table.organizationId, table.productId, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "stock_movements_product_org_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.inventoryId],
      foreignColumns: [inventoryBalances.organizationId, inventoryBalances.id],
      name: "stock_movements_inventory_org_fk",
    }),
    check("stock_movements_quantity_positive", sql`${table.quantity} > 0`),
  ],
);
