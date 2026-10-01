import { and, count, desc, eq, gte, lt, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { auditEvents } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3 — every read requires a TenantContext. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "select">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

export interface AuditEventFilters {
  action?: string;
  actorType?: "user" | "service";
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
}

/** One WHERE for both the page and its count. Uses (org, created_at) and (org, resource_type, resource_id) indexes. */
function auditConditions(tenant: TenantContext, filters: AuditEventFilters): SQL | undefined {
  const conditions = [eq(auditEvents.organizationId, tenant.organizationId)];
  if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
  if (filters.actorType) conditions.push(eq(auditEvents.actorType, filters.actorType));
  if (filters.resourceType) conditions.push(eq(auditEvents.resourceType, filters.resourceType));
  if (filters.resourceId) conditions.push(eq(auditEvents.resourceId, filters.resourceId));
  if (filters.from) conditions.push(gte(auditEvents.createdAt, new Date(filters.from)));
  if (filters.to) conditions.push(lt(auditEvents.createdAt, new Date(filters.to)));
  return and(...conditions);
}

/** Newest first; `id` breaks ties. Never selects `organization_id` into the public shape. */
export async function listAuditEvents(
  tenant: TenantContext,
  filters: AuditEventFilters & { limit: number; offset: number },
  executor: Executor = db,
) {
  assertTenant(tenant);
  return executor
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorType: auditEvents.actorType,
      actorId: auditEvents.actorId,
      resourceType: auditEvents.resourceType,
      resourceId: auditEvents.resourceId,
      requestId: auditEvents.requestId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(auditConditions(tenant, filters))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(filters.limit)
    .offset(filters.offset);
}

export async function countAuditEvents(tenant: TenantContext, filters: AuditEventFilters, executor: Executor = db): Promise<number> {
  assertTenant(tenant);
  const [row] = await executor.select({ total: count() }).from(auditEvents).where(auditConditions(tenant, filters));
  return row?.total ?? 0;
}
