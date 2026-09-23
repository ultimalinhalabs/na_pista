import { db } from "../../db/index.js";
import { recordAuditEvent } from "../audit/service.js";
import { TimezoneNotConfiguredError } from "../../shared/errors.js";
import { getOrganizationSettings, upsertOrganizationSettings, type TenantContext } from "./repository.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

/** `null` (never a default) when the organization hasn't configured a timezone yet — ADR-040 "no silent fallback". */
export async function getOrganizationSettingsOrNull(tenant: TenantContext) {
  const row = await getOrganizationSettings(tenant);
  return row ?? null;
}

/** Used by Scheduling's availability engine — fails closed rather than falling back to any default. */
export async function getTimezoneOrThrow(tenant: TenantContext): Promise<string> {
  const row = await getOrganizationSettings(tenant);
  if (!row) throw new TimezoneNotConfiguredError();
  return row.timezone;
}

/**
 * No usage event here — F26A's usage decision (docs/f26a-report.md §31)
 * enumerated exactly `schedule.updated`/`schedule.exception.created` as
 * the `api_requests`-emitting writes; organization_settings was not
 * included, and this stays within that frozen decision rather than
 * silently extending it (F26 brief §2: "do not reopen decisions already
 * resolved by F26A").
 */
export async function updateOrganizationSettings(tenant: TenantContext, actor: Actor, requestId: string | undefined, timezone: string) {
  return db.transaction(async (tx) => {
    const row = await upsertOrganizationSettings(tenant, timezone, tx);
    await recordAuditEvent(
      {
        organizationId: tenant.organizationId,
        actorType: actor.type,
        actorId: actor.id,
        action: "organization_settings.updated",
        resourceType: "organization_settings",
        resourceId: tenant.organizationId,
        metadata: { timezone },
        requestId,
      },
      tx,
    );
    return row;
  });
}
