import { pgSchema, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Dedicated schema, not the `public` schema — kept structurally distinct
 * from anything UL Platform owns even though (in this spike environment
 * only) it lives on the same physical Postgres server. See
 * docs/decisions.md ADR-015. Must match NA_PISTA_DB_SCHEMA in .env.
 */
export const naPistaSchema = pgSchema("na_pista_spike");

export const products = naPistaSchema.table(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite uniqueness is what makes a future FK *into* this table
    // tenant-safe (tenancy.md §3) — not exercised by this minimal spike
    // (Product has no children here), but kept as the real pattern.
    uniqueIndex("products_org_id_unique").on(table.organizationId, table.id),
  ],
);
