import { index, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { naPistaSchema } from "./categories.js";
import { timestamps } from "./_helpers.js";

/**
 * F25A (ADR-036): Professional is deliberately NOT a Product/Service
 * clone and NOT a Platform User — no `userId`/`platformUserId` (a
 * future optional link, if ever needed, is documented in ADR-036/038,
 * not built here), no `customerId`/`serviceId`/`appointmentId`/
 * `scheduleId`, no calendar/availability/working-hours/vacation/
 * commission/payroll/rating/booking fields. An operational resource
 * that may never sign in to anything (F25A brief §4/§25).
 *
 * `phone`/`email` reuse Customer's exact validators (now exported from
 * `customers/schemas.ts`) — informative only, never authentication
 * identity. No uniqueness on `name`/`phone`/`email` (ADR-036) — the
 * same reasoning ADR-024 already gives for `Customer`.
 *
 * `status`: ACTIVE | ARCHIVED only (ADR-036), the same two-state
 * lifecycle every module uses — no `ON_LEAVE`/`BUSY`/`AVAILABLE`/
 * `VACATION`/`OFFLINE` (those describe Scheduling/Availability state,
 * F26's domain, never catalog membership).
 */
export const professionals = naPistaSchema.table(
  "professionals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    phone: text("phone"),
    email: text("email"),
    status: text("status", { enum: ["ACTIVE", "ARCHIVED"] }).notNull().default("ACTIVE"),
    ...timestamps,
  },
  (table) => [
    // Composite-FK-target for professional_services below.
    uniqueIndex("professionals_org_id_unique").on(table.organizationId, table.id),
    index("professionals_org_created_idx").on(table.organizationId, table.createdAt),
    index("professionals_org_status_idx").on(table.organizationId, table.status),
  ],
);
