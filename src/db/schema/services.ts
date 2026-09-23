import { check, index, integer, numeric, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";
import { timestamps } from "./_helpers.js";

/**
 * F24A (ADR-033/034/035): Service is deliberately NOT a Product clone —
 * no `categoryId` (no demonstrated grouping requirement yet, unlike
 * Product which got Categories from its own first slice), no `unit`
 * (nothing analogous to a sellable measure), and — critically — no
 * reference at all to Customer/Professional/Appointment/Scheduling
 * (ADR-035: Service is "what", kept fully independent of "who"/"when"/
 * "the actual booking", none of which exist yet).
 *
 * `durationMinutes integer` (ADR-034) — a deliberate exception to the
 * money/quantity decimal-string convention: a bounded positive integer
 * has no IEEE-754 precision problem for that convention to solve, so it
 * is a plain column/plain JSON number, not `numeric`.
 *
 * `price numeric(14,2)`, nullable — exactly Product's own ADR-031 model,
 * reused without modification (ADR-034): `NULL` ("not yet priced") and
 * `0` ("deliberately free") are distinct, both valid. No `currency`
 * column — a Service's price is denominated in the Organization's single
 * operating currency, implicit, never redundantly stored (ADR-030,
 * extended by ADR-034) — the same reasoning that keeps Product currency-
 * free.
 *
 * `status`: ACTIVE | ARCHIVED only (ADR-033), matching every other
 * module's two-state lifecycle — no third state, nothing demonstrates a
 * need for one.
 *
 * No unique constraint on `name` (ADR-033/F24A brief §6) — two Services
 * may legitimately share a name, same reasoning ADR-024 already applied
 * to `Customer.name`.
 *
 * F25 (ADR-037): `services_org_id_unique` below is the ONE authorized
 * change to this table — a composite-FK-target unique index, added now
 * because `professional_services` is the first thing that ever needs to
 * reference a Service by FK (the exact same one-line addition F23 made
 * to `customers` the moment `orders` first needed one). Nothing else
 * about Service's own shape/semantics changes.
 */
export const services = naPistaSchema.table(
  "services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull(),
    price: numeric("price", { precision: 14, scale: 2 }),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("services_org_id_unique").on(table.organizationId, table.id),
    index("services_org_created_idx").on(table.organizationId, table.createdAt),
    index("services_org_status_idx").on(table.organizationId, table.status),
    check("services_duration_minutes_positive", sql`${table.durationMinutes} > 0`),
    check("services_price_non_negative", sql`${table.price} IS NULL OR ${table.price} >= 0`),
  ],
);
