import { check, date, foreignKey, index, time, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";
import { professionals } from "./professionals.js";

/**
 * ADR-039 (F26A): date-specific overrides that FULLY REPLACE the weekly
 * rule for that date — never a partial merge (ADR-039 D4/D14). Two row
 * shapes share this one table:
 *  - `startLocalTime`/`endLocalTime` BOTH set = "available these
 *    specific intervals on this date" — can open a normally-closed day,
 *    narrow, or widen a normally-open one. Multiple rows per date are
 *    allowed (one per interval, same "rows not arrays" convention as
 *    `professional_schedule_rules`).
 *  - `startLocalTime`/`endLocalTime` BOTH `NULL` = an explicit "fully
 *    unavailable this date" marker. At most ONE such closed-marker row
 *    per `(organizationId, professionalId, date)` — enforced by the
 *    partial unique index below (translated to `409 CONFLICT` via
 *    `isUniqueViolationError`, the same mechanism `professional_services`
 *    already uses for its own duplicate-association case).
 *
 * A closed-marker row cannot coexist with interval rows for the same
 * date — that contradiction is rejected at the domain-service layer
 * (an application-level check inside the same transaction; not a DB
 * constraint, since exception writes are low-frequency/low-contention
 * staff configuration, not a high-throughput resource like Inventory —
 * docs/f26-report.md §9).
 *
 * `date` is a plain Postgres `DATE` — the organization's own calendar
 * date, never a UTC-anchored timestamp (ADR-040). Physical `DELETE`
 * (ADR-039 D32) — created/removed individually by row id, never edited
 * in place (no `PATCH`; delete + recreate instead, ADR-039 D24).
 */
export const professionalScheduleExceptions = naPistaSchema.table(
  "professional_schedule_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    professionalId: uuid("professional_id").notNull(),
    date: date("date", { mode: "string" }).notNull(),
    startLocalTime: time("start_local_time"),
    endLocalTime: time("end_local_time"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("professional_schedule_exceptions_org_professional_date_idx").on(table.organizationId, table.professionalId, table.date),
    uniqueIndex("professional_schedule_exceptions_closed_marker_unique")
      .on(table.organizationId, table.professionalId, table.date)
      .where(sql`${table.startLocalTime} IS NULL`),
    foreignKey({
      columns: [table.organizationId, table.professionalId],
      foreignColumns: [professionals.organizationId, professionals.id],
      name: "professional_schedule_exceptions_professional_org_fk",
    }),
    check(
      "professional_schedule_exceptions_interval_shape",
      sql`(${table.startLocalTime} IS NULL AND ${table.endLocalTime} IS NULL) OR (${table.startLocalTime} IS NOT NULL AND ${table.endLocalTime} IS NOT NULL AND ${table.endLocalTime} > ${table.startLocalTime})`,
    ),
  ],
);
