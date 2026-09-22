import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { naPistaSchema } from "./categories.js";

/**
 * ADR-023 / audit.md (F18): Na Pista's OWN business audit trail —
 * distinct from UL Platform's control-plane audit (which never sees
 * business resources). Append-only; nothing in this codebase ever
 * updates or deletes a row after insert.
 */
export const auditEvents = naPistaSchema.table(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    actorType: text("actor_type", { enum: ["user", "service"] }).notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    metadata: jsonb("metadata"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_org_created_idx").on(table.organizationId, table.createdAt),
    index("audit_events_org_resource_idx").on(table.organizationId, table.resourceType, table.resourceId),
  ],
);
