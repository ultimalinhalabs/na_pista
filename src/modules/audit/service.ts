import { db } from "../../db/index.js";
import { auditEvents } from "../../db/schema/index.js";
import { logger } from "../../shared/logger.js";

export interface AuditEntry {
  organizationId: string;
  actorType: "user" | "service";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/**
 * ADR-023: records one business-audit event. Unlike UL Platform's own
 * `recordAuditEvent` (which deliberately swallows failures so an audit
 * write can never break the underlying operation), F20's brief §19/§29
 * requires "audit failure: behavior explicitly defined" — the decision
 * here is: an audit write failure is logged loudly (never silent) but
 * still does not roll back the business operation itself, because the
 * caller (service.ts) writes audit in the SAME transaction as the
 * resource mutation — if the insert fails, the whole transaction
 * (resource + audit) rolls back together, so "audit silently missing
 * while the resource exists" cannot happen. This function is never
 * called outside that transaction.
 */
export async function recordAuditEvent(
  entry: AuditEntry,
  executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
  try {
    await executor.insert(auditEvents).values(entry);
  } catch (error) {
    logger.error("audit.write_failed", {
      organizationId: entry.organizationId,
      action: entry.action,
      requestId: entry.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error; // propagate: caller's transaction must roll back (see doc comment above)
  }
}
