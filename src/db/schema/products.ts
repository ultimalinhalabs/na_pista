import { foreignKey, index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { categories, naPistaSchema } from "./categories.js";

/**
 * ADR-018/ADR-020: minimal Product — id/organizationId/categoryId(optional)
 * /name/description/status. No price (OD-01 from F18 is still open —
 * currency/decimalization undecided; inventing one here would be exactly
 * the "don't invent a financial model" the F20 brief warns against, and
 * this slice's form (name/description/category/status) doesn't need it).
 * No variants/inventory/barcode/suppliers — explicitly deferred (modules.md).
 *
 * status: ACTIVE | ARCHIVED only (ADR-020) — no separate INACTIVE state
 * yet: without an Orders module, a third state has no distinct meaning to
 * define ("temporarily unavailable for purchase" only makes sense once
 * purchasing exists) — adding it speculatively would be exactly the
 * "workflow excessivo" the brief warns against. Aditive later.
 *
 * ADR-027 (F22): `unit` lives on Product, not on Inventory — it is an
 * intrinsic property of the thing being measured ("this product is
 * always counted in kg"), never something that varies per inventory
 * record or changes independently of the product. Keeping it here also
 * avoids duplicating the concept across two tables. Minimal fixed enum,
 * not a UOM engine (OD-04, closed for this slice — see ADR-027).
 */
export const products = naPistaSchema.table(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    categoryId: uuid("category_id"),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
    unit: text("unit", { enum: ["UNIT", "KG", "G", "L", "ML"] }).notNull().default("UNIT"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("products_org_id_unique").on(table.organizationId, table.id),
    index("products_org_created_idx").on(table.organizationId, table.createdAt),
    index("products_org_category_idx").on(table.organizationId, table.categoryId),
    index("products_org_status_idx").on(table.organizationId, table.status),
    // Composite FK: a product can only ever reference a category that
    // belongs to the SAME organization — enforced by Postgres, not just
    // application code (tenancy.md §3 / F20 brief §15). NULL categoryId
    // (no category) is never checked by this constraint (Postgres FK
    // semantics: any NULL column in a composite FK exempts the row).
    foreignKey({
      columns: [table.organizationId, table.categoryId],
      foreignColumns: [categories.organizationId, categories.id],
      name: "products_category_org_fk",
    }),
  ],
);
