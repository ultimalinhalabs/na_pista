import { text, uuid } from "drizzle-orm/pg-core";
import { naPistaSchema } from "./categories.js";
import { timestamps } from "./_helpers.js";

/**
 * ADR-040 (F26A): Na Pista owns organization-level timezone
 * configuration — NOT a UL Platform change. `ul-platform`'s own
 * `organizations` table has no timezone/locale field, and no
 * `TenantSettings` table exists anywhere (confirmed by direct
 * inspection in F26A, docs/f26a-report.md §9/§39). No other UL Platform
 * product has a demonstrated cross-application need for this today — if
 * one ever does, promoting the concept to Platform is a real future
 * decision, not made speculatively here.
 *
 * One row per Organization, 1:1 — keyed directly by `organizationId`,
 * no separate surrogate id (this is a singleton settings row, not a
 * collection, unlike every other Na Pista table).
 *
 * `timezone` is `NOT NULL`: an Organization that has never configured
 * Scheduling simply has NO row here at all — not a row holding a
 * default/fallback value. Availability computation must fail closed
 * (TIMEZONE_NOT_CONFIGURED) until a row is explicitly created via
 * `PUT .../settings`. Never server timezone, never browser timezone,
 * never a hardcoded default written by a migration (ADR-040 "no silent
 * fallback").
 *
 * `timezone` is an IANA identifier string (e.g. "Africa/Luanda"),
 * validated at the Zod layer against `Intl.supportedValuesOf`
 * ("timeZone") — never a raw UTC offset.
 */
export const organizationSettings = naPistaSchema.table("organization_settings", {
  organizationId: uuid("organization_id").primaryKey(),
  timezone: text("timezone").notNull(),
  ...timestamps,
});
