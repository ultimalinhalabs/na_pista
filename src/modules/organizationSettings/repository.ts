import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { organizationSettings } from "../../db/schema/index.js";

/** tenancy.md §3 layer 3: the only place with SQL for organization_settings — requires a TenantContext, same guard convention as every other module. */
export interface TenantContext {
  organizationId: string;
}

type Executor = Pick<typeof db, "insert" | "select">;

function assertTenant(tenant: TenantContext | undefined | null): asserts tenant is TenantContext {
  if (!tenant?.organizationId) {
    throw new Error("BUG: repository called without a TenantContext");
  }
}

/** No row = "timezone not configured" (ADR-040 "no silent fallback") — never a default row, never a nullable-with-fallback column. */
export async function getOrganizationSettings(tenant: TenantContext, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor.select().from(organizationSettings).where(eq(organizationSettings.organizationId, tenant.organizationId)).limit(1);
  return row;
}

/** `PUT` semantics: create the settings row if it doesn't exist yet, replace `timezone` if it does — one atomic upsert, never a check-then-insert/update race. */
export async function upsertOrganizationSettings(tenant: TenantContext, timezone: string, executor: Executor = db) {
  assertTenant(tenant);
  const [row] = await executor
    .insert(organizationSettings)
    .values({ organizationId: tenant.organizationId, timezone })
    .onConflictDoUpdate({ target: organizationSettings.organizationId, set: { timezone, updatedAt: new Date() } })
    .returning();
  return row!;
}
