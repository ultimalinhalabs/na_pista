import { logger } from "../../shared/logger.js";
import { revokeManagedCredentialLocally } from "./service.js";

const KEY_ID = /^ulk_([0-9a-f-]{36})\./i;

/**
 * D2-B — called after an outbound Platform call made with the organization's stored credential.
 * Only `401 CREDENTIAL_REVOKED` retires the local copy: the Platform emits it after verifying the
 * secret, so it is the Platform itself confirming the revocation (never a transient failure).
 * Every other non-success keeps failing closed through the caller, without touching local state.
 */
export async function retireLocalCredentialIfRevoked(
  organizationId: string,
  credential: string,
  res: { status: number; error?: { code: string } },
  requestId?: string,
): Promise<void> {
  if (res.status !== 401 || res.error?.code !== "CREDENTIAL_REVOKED") return;
  const platformApiKeyId = KEY_ID.exec(credential)?.[1];
  if (!platformApiKeyId) return;
  try {
    await revokeManagedCredentialLocally(organizationId, platformApiKeyId, {
      actor: { type: "service", id: "system:platform-revocation" },
      requestId,
      reason: "revoked_by_platform",
    });
  } catch (error) {
    logger.warn("platform_credential.local_revoke_failed", { organizationId, error: error instanceof Error ? error.name : "unknown", requestId });
  }
}
