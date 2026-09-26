import { check, foreignKey, index, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";
import { customers } from "./customers.js";
import { professionals } from "./professionals.js";
import { services } from "./services.js";
import { timestamps } from "./_helpers.js";

/**
 * F27 (ADR-042): one staff-committed reservation of one Professional's
 * time, for one Service, for one Na Pista business Customer (never a UL
 * Platform User), over one absolute half-open interval `[start_at,
 * end_at)`. All three references are REQUIRED and composite-FK'd on this
 * row's own `organization_id` — the `professional_services`/`order_items`
 * mechanism — so a cross-tenant reference is unrepresentable.
 *
 * Time (ADR-040/042): `start_at`/`end_at` are `timestamptz` absolute
 * instants. There is deliberately NO `duration_minutes` column: `end_at -
 * start_at` IS the booked duration, frozen at creation from the live
 * `Service.durationMinutes` and preserved on reschedule. `end_at` must be
 * a stored column because the conflict constraint indexes
 * `tstzrange(start_at, end_at)` — `start_at + interval` is STABLE, not
 * IMMUTABLE, so it cannot back an index.
 *
 * Snapshots (ADR-034/042): `service_name`, `service_price` (NULL = the
 * Service was unpriced at booking; unpriced Services CAN be booked — a
 * reservation is not a sale), `currency` — captured once at creation,
 * never re-captured on reschedule, never touched by later Service edits.
 * No Customer/Professional name snapshot (live records; edits are
 * corrections that should propagate).
 *
 * Lifecycle (ADR-043, extended by ADR-048/F28B): SCHEDULED -> COMPLETED |
 * CANCELED | NO_SHOW, all terminal. NO_SHOW keeps occupying its interval —
 * the exclusion constraint's predicate `status <> 'CANCELED'` already
 * covers it, so the constraint is deliberately NOT changed.
 * The CHECKs below guarantee the row is never internally inconsistent
 * whatever code path writes it; transition LEGALITY lives in
 * `modules/appointments/lifecycle.ts`.
 *
 * CONFLICT CONSTRAINT — NOT EXPRESSIBLE IN DRIZZLE'S DSL (ADR-044):
 * `appointments_professional_no_overlap` is created by the hand-written
 * migration `drizzle/migrations/0008_appointments_no_overlap.sql`:
 *
 *   EXCLUDE USING gist (
 *     organization_id WITH =, professional_id WITH =,
 *     tstzrange(start_at, end_at, '[)') WITH &&
 *   ) WHERE (status <> 'CANCELED')
 *
 * (requires the `btree_gist` extension, installed in Supabase's
 * `extensions` schema by the same migration). `drizzle-kit generate`
 * diffs its own snapshots, never the live DB, so it never drops it;
 * `drizzle-kit push` must not be used against this schema. A regression
 * test asserts the constraint exists (`pg_constraint.contype = 'x'`).
 * Its GiST index doubles as the index for "occupying appointments of a
 * Professional in a time window" (bookable slots).
 */
export const appointments = naPistaSchema.table(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    professionalId: uuid("professional_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["SCHEDULED", "COMPLETED", "CANCELED", "NO_SHOW"] }).notNull().default("SCHEDULED"),
    serviceName: text("service_name").notNull(),
    servicePrice: numeric("service_price", { precision: 14, scale: 2 }),
    currency: text("currency").notNull(),
    notes: text("notes"),
    cancellationReason: text("cancellation_reason"),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    noShowAt: timestamp("no_show_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    // Date-window listing across the whole tenant (day view without a professional filter).
    index("appointments_org_start_idx").on(table.organizationId, table.startAt),
    // Professional-filtered listing INCLUDING canceled rows (the partial GiST index excludes them).
    index("appointments_org_professional_start_idx").on(table.organizationId, table.professionalId, table.startAt),
    // Customer history.
    index("appointments_org_customer_start_idx").on(table.organizationId, table.customerId, table.startAt),
    foreignKey({
      columns: [table.organizationId, table.customerId],
      foreignColumns: [customers.organizationId, customers.id],
      name: "appointments_customer_org_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.professionalId],
      foreignColumns: [professionals.organizationId, professionals.id],
      name: "appointments_professional_org_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.serviceId],
      foreignColumns: [services.organizationId, services.id],
      name: "appointments_service_org_fk",
    }),
    check("appointments_end_after_start", sql`${table.endAt} > ${table.startAt}`),
    check("appointments_status_valid", sql`${table.status} IN ('SCHEDULED', 'COMPLETED', 'CANCELED', 'NO_SHOW')`),
    check("appointments_canceled_at_matches_status", sql`(${table.status} = 'CANCELED') = (${table.canceledAt} IS NOT NULL)`),
    check("appointments_completed_at_matches_status", sql`(${table.status} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`),
    check("appointments_no_show_at_matches_status", sql`(${table.status} = 'NO_SHOW') = (${table.noShowAt} IS NOT NULL)`),
    check("appointments_cancellation_reason_only_when_canceled", sql`${table.cancellationReason} IS NULL OR ${table.status} = 'CANCELED'`),
    check("appointments_service_price_non_negative", sql`${table.servicePrice} IS NULL OR ${table.servicePrice} >= 0`),
    check("appointments_currency_shape", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);
