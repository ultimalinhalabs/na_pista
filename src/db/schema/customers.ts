import { index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_helpers.js";
import { naPistaSchema } from "./categories.js";

/**
 * ADR-024/ADR-025: a Na Pista business customer — deliberately NOT the
 * same concept as a UL Platform User/`users` row (no FK, no relation, no
 * call to any Platform identity endpoint). A Customer is a record of who
 * a business serves, and may never have signed in to anything.
 *
 * Deliberately minimal (F21 brief §3): no dateOfBirth, gender, taxNumber,
 * address hierarchy, loyalty points, segments, lead score, LTV, avatar,
 * payment/billing fields — none justified by any requirement seen so far.
 * `status`: ACTIVE | ARCHIVED only, same two-state lifecycle as Product/
 * Category (ADR-020/ADR-026) — DELETE archives, never a physical delete.
 *
 * No tenant-scoped uniqueness on name/email/phone (ADR-024 §Uniqueness):
 * real businesses have customers sharing a phone (family), no email, or
 * duplicate names — inventing a constraint here would reject legitimate
 * data. The 409 machinery (`isUniqueViolationError`) is preserved and
 * ready the day a real constraint is justified; none exists yet.
 */
export const customers = naPistaSchema.table(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    // Matches the real query shapes this module actually runs (F21 brief
    // §11: no speculative indexes) — list-by-tenant-ordered-by-recency,
    // and the status filter every list call applies by default.
    index("customers_org_created_idx").on(table.organizationId, table.createdAt),
    index("customers_org_status_idx").on(table.organizationId, table.status),
    // F23: composite-FK target for orders.customer_id (same pattern
    // ADR-021 established for products -> categories) — added now because
    // Order is the first thing that ever needs to reference a Customer by
    // FK; nothing about Customer's own behavior changes.
    uniqueIndex("customers_org_id_unique").on(table.organizationId, table.id),
  ],
);
