import { index, pgSchema, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";

/**
 * Dedicated schema, not `public` — kept structurally distinct from
 * anything UL Platform owns, even though (in this environment only) it
 * lives on the same physical Postgres server (docs/decisions.md OD-16 /
 * ADR-015). Must match NA_PISTA_DB_SCHEMA.
 */
export const naPistaSchema = pgSchema("na_pista");

/**
 * ADR-019: Category is tenant-scoped, no global categories in this phase
 * (modules.md OD-08: flat, no parent/tree yet — add `parentId` later,
 * aditive, if a real requirement shows up).
 */
export const categories = naPistaSchema.table(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    // What makes a composite FK from `products` into this table possible
    // (tenancy.md §3): a product can never reference a category from a
    // different organization, enforced by Postgres itself, not just by
    // application code.
    uniqueIndex("categories_org_id_unique").on(table.organizationId, table.id),
    // organization_id-first index: every real query filters by tenant first.
    index("categories_org_created_idx").on(table.organizationId, table.createdAt),
  ],
);
