import { check, foreignKey, index, integer, time, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";
import { professionals } from "./professionals.js";

/**
 * ADR-039 (F26A): weekly recurring working intervals, Professional-
 * centric — NEVER a `serviceId` column; compatibility stays
 * `professional_services`'s own job, never duplicated here (ADR-039
 * D12). One row per interval — rows, not an array/JSON column, matching
 * `order_items`/`professional_services`'s established convention.
 * Multiple intervals per day = multiple rows sharing `dayOfWeek` (this
 * is how a lunch break is represented — no dedicated `Break` entity,
 * ADR-039 D5). A closed day = zero rows for that `dayOfWeek` (ADR-039
 * D33: empty means unavailable, fail-closed — restated in the domain
 * service, not just here).
 *
 * `startLocalTime`/`endLocalTime` are Postgres `TIME` — wall-clock,
 * no timezone attached at the row, re-resolved against
 * `organization_settings.timezone` at read/compute time (ADR-040).
 * **Overnight intervals (22:00->02:00) are explicitly NOT supported in
 * F26** (ADR-039 D3) — enforced below by
 * `end_local_time > start_local_time`, the same "reject, never silently
 * transform" posture as every other boundary check in this codebase.
 *
 * Cross-row overlap/zero-length validation happens at the domain-
 * service layer (it needs to compare a whole day's submitted rows
 * together — not expressible as a single-row `CHECK`) — see
 * `modules/scheduling/service.ts`. Adjacent intervals (`08:00-12:00`,
 * `12:00-17:00`) are accepted, not merged/normalized and not rejected —
 * a deliberate F26 decision (docs/f26-report.md §8).
 *
 * Physical `DELETE`, never archived (ADR-039 D32): a schedule rule is
 * configuration, not a business/historical record — the same posture
 * `professional_services` already established for configuration-shaped
 * tables. The whole weekly set is replaced atomically on every `PUT`
 * (delete all + insert all, one transaction, ADR-039 D10) — no separate
 * lifecycle status exists (ADR-039 D31).
 */
export const professionalScheduleRules = naPistaSchema.table(
  "professional_schedule_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    professionalId: uuid("professional_id").notNull(),
    dayOfWeek: integer("day_of_week").notNull(),
    startLocalTime: time("start_local_time").notNull(),
    endLocalTime: time("end_local_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("professional_schedule_rules_org_professional_idx").on(table.organizationId, table.professionalId),
    foreignKey({
      columns: [table.organizationId, table.professionalId],
      foreignColumns: [professionals.organizationId, professionals.id],
      name: "professional_schedule_rules_professional_org_fk",
    }),
    check("professional_schedule_rules_day_of_week_range", sql`${table.dayOfWeek} >= 0 AND ${table.dayOfWeek} <= 6`),
    check("professional_schedule_rules_end_after_start", sql`${table.endLocalTime} > ${table.startLocalTime}`),
  ],
);
