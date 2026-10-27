import { check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { naPistaSchema } from "./categories.js";

/**
 * ADR-073 — one row per (organization, actor, Idempotency-Key) for the creating endpoints that a retry could
 * duplicate (orders, customers, stock movements). Written in the SAME transaction as the business fact: if the
 * transaction commits, the key is bound to the created resource; if it rolls back (validation, stock, archived
 * product…), the key leaves no trace and a retry is processed again.
 *
 * Deliberately stores NO response body (no copy of personal data): a replay re-reads the resource by
 * `resource_id`, scoped to the organization. `request_hash` = sha256 of the operation, its path parameters and
 * the validated body, so the same key with a different request is refused (409 IDEMPOTENCY_KEY_REUSED).
 */
export const idempotencyKeys = naPistaSchema.table(
  "idempotency_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    actorType: text("actor_type", { enum: ["user", "service"] }).notNull(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    resourceId: uuid("resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idempotency_keys_scope_unique").on(table.organizationId, table.actorType, table.actorId, table.idempotencyKey),
    index("idempotency_keys_created_at_idx").on(table.createdAt),
    check("idempotency_keys_actor_type_valid", sql`${table.actorType} IN ('user', 'service')`),
    check("idempotency_keys_key_length", sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`),
  ],
);
