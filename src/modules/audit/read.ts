import { pageRequest, type Page } from "../../shared/listing.js";
import { countAuditEvents, listAuditEvents, type TenantContext } from "./repository.js";
import { AUDIT_DEFAULT_PAGE_SIZE, type ListAuditEventsQuery } from "./schemas.js";

/**
 * ADR-055: defence in depth. Audit metadata is written only by Na Pista code
 * and is already secret-free (F29A tests); still, any key that looks like it
 * could hold secret material is redacted on the way out, at any depth.
 */
const SECRET_KEY = /secret|token|password|passphrase|credential|ciphertext|encrypted|authorization|private.?key/i;
export const REDACTED = "[REDACTED]";

export function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? REDACTED : redactMetadata(v);
    return out;
  }
  return value;
}

type AuditRow = Awaited<ReturnType<typeof listAuditEvents>>[number];
export type AuditEventView = Omit<AuditRow, "metadata"> & { metadata: Record<string, unknown> | null };

export async function listAuditEventsPage(tenant: TenantContext, query: ListAuditEventsQuery): Promise<Page<AuditEventView>> {
  const { page, pageSize, offset } = pageRequest(query, AUDIT_DEFAULT_PAGE_SIZE);
  const { page: _p, pageSize: _s, limit: _l, ...filters } = query;
  const [rows, total] = await Promise.all([
    listAuditEvents(tenant, { ...filters, limit: pageSize, offset }),
    countAuditEvents(tenant, filters),
  ]);
  const items = rows.map((row) => ({
    ...row,
    metadata: row.metadata && typeof row.metadata === "object" ? (redactMetadata(row.metadata) as Record<string, unknown>) : null,
  }));
  return { items, page, pageSize, total };
}
