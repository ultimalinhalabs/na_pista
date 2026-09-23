import { check, foreignKey, index, numeric, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";
import { customers } from "./customers.js";
import { products } from "./products.js";
import { timestamps } from "./_helpers.js";

/**
 * F23A (ADR-030/ADR-032): the first real Commerce entity. Tenant-scoped
 * like every prior module. `customerId` is nullable — a walk-in/anonymous
 * sale is a real, common flow (F18 PD-8, closed by F23A/OD-03) — and
 * composite-FK'd to `customers` exactly like `products.category_id` (a
 * NULL customerId is exempt from the FK check, same Postgres semantics).
 *
 * `currency` is a creation-time SNAPSHOT (ADR-030) — never re-derived from
 * live Organization/TenantSettings configuration, so a later currency
 * change (if Na Pista ever supports one) can never retroactively
 * reinterpret a historical Order's stored amounts. Shape-validated only
 * (`^[A-Z]{3}$`) — the *specific* currently-supported currency (AOA) is an
 * application-level constant, not hardcoded into this constraint, so
 * adding a currency later never needs a migration here.
 *
 * `subtotal`/`total` are numeric(14,2) (ADR-029), server-computed by
 * summing `order_items.subtotal` (never client-supplied, never derived
 * from JS float arithmetic) — see `src/modules/orders/repository.ts`
 * `recalculateOrderTotals`. `total = subtotal` always in this slice (no
 * tax/discount/shipping/fees exist yet, F23 brief §7) — deliberately no
 * separate columns for those, added only if a real requirement appears.
 */
export const orders = naPistaSchema.table(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    customerId: uuid("customer_id"),
    status: text("status", { enum: ["DRAFT", "CONFIRMED", "COMPLETED", "CANCELED"] }).notNull().default("DRAFT"),
    currency: text("currency").notNull(),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 2 }).notNull().default("0"),
    ...timestamps,
  },
  (table) => [
    // Composite-FK target for order_items below.
    uniqueIndex("orders_org_id_unique").on(table.organizationId, table.id),
    index("orders_org_created_idx").on(table.organizationId, table.createdAt),
    index("orders_org_status_idx").on(table.organizationId, table.status),
    index("orders_org_customer_idx").on(table.organizationId, table.customerId),
    foreignKey({
      columns: [table.organizationId, table.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: "orders_customer_org_fk",
    }),
    check("orders_subtotal_non_negative", sql`${table.subtotal} >= 0`),
    check("orders_total_non_negative", sql`${table.total} >= 0`),
    check("orders_currency_shape", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * ADR-031: `productName`/`unitPrice` are SNAPSHOTS, copied from `products`
 * at creation time and never re-read afterward — a later Product rename or
 * price change never touches an existing OrderItem (F23 brief §6, the
 * "10,000 Kz then 12,000 Kz" example). `subtotal` is computed once, in SQL
 * (`ROUND(unit_price * quantity, 2)`, ADR-029), and stored — never
 * recomputed on read, so a future rounding-rule revisit never silently
 * changes a past Order's numbers.
 *
 * `quantity numeric(20,6)` — deliberately reuses Inventory's own
 * representation (ADR-027), not a new one, because a future
 * `StockMovement` created at Order confirmation consumes this exact value
 * (ADR-032) — a different precision here would force a lossy conversion
 * exactly at that boundary.
 */
export const orderItems = naPistaSchema.table(
  "order_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    orderId: uuid("order_id").notNull(),
    productId: uuid("product_id").notNull(),
    productName: text("product_name").notNull(),
    quantity: numeric("quantity", { precision: 20, scale: 6 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull(),
    subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("order_items_org_order_idx").on(table.organizationId, table.orderId),
    // Tenant-safe references, same composite-FK pattern ADR-021/ADR-027 already proved.
    foreignKey({
      columns: [table.organizationId, table.orderId],
      foreignColumns: [orders.organizationId, orders.id],
      name: "order_items_order_org_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.productId],
      foreignColumns: [products.organizationId, products.id],
      name: "order_items_product_org_fk",
    }),
    check("order_items_quantity_positive", sql`${table.quantity} > 0`),
    check("order_items_unit_price_non_negative", sql`${table.unitPrice} >= 0`),
    check("order_items_subtotal_non_negative", sql`${table.subtotal} >= 0`),
  ],
);
