import { callPlatform } from "./client.js";
import { PlatformCredentialUnavailableError, resolvePlatformCredential } from "../modules/platformCredentials/resolver.js";
import { logger } from "../shared/logger.js";

/**
 * ADR-023: usage is observability/metering, never authorization — a
 * failed usage write must NEVER break the business operation that
 * triggered it (same "never break the calling operation" posture
 * audit/service.ts already documents for the Platform's own audit log).
 *
 * Meter choice: `api_requests` — the only meter already seeded and
 * allow-listed for NA_PISTA (see db/seed/data.ts in ul-platform;
 * confirmed by reading it, not assumed). A dedicated `products` meter
 * does not exist yet (F19's platform-changes-required.md §PC-5); rather
 * than invent one that the Platform would reject (unknown meter ->
 * VALIDATION_ERROR, or not-allow-listed -> FORBIDDEN), this records each
 * product/category write against `api_requests`, which is honest about
 * what it measures ("a write request happened") without pretending to
 * be a `products.created` meter that doesn't exist on the Platform.
 */
const METER_KEY = "api_requests";

export async function recordUsage(
  organizationId: string,
  idempotencyKey: string,
  metadata: Record<string, unknown>,
  requestId?: string,
): Promise<void> {
  // F29A: usage never breaks the business operation (ADR-023), so an
  // unavailable credential skips the write — the resolver has already
  // logged why (reason code only, never the secret).
  let credential: string;
  try {
    credential = await resolvePlatformCredential(organizationId, { requestId });
  } catch (error) {
    // Never rethrow: usage must not break the operation, whatever went wrong.
    logger.warn("usage.write.skipped_no_credential", {
      organizationId,
      requestId,
      reason: error instanceof PlatformCredentialUnavailableError ? error.reason : "UNEXPECTED",
    });
    return;
  }

  try {
    const res = await callPlatform("POST", `/organizations/${organizationId}/applications/NA_PISTA/usage`, {
      token: credential,
      requestId,
      body: { meterKey: METER_KEY, quantity: 1, idempotencyKey, metadata },
    });
    if (res.status !== 200 && res.status !== 201) {
      logger.warn("usage.write.failed", { organizationId, requestId, status: res.status, errorCode: res.error?.code });
    }
  } catch (error) {
    // Fail open for usage specifically (ADR-017: telemetry/analytics MAY
    // degrade gracefully — usage is exactly that category, unlike
    // authorization/entitlement checks, which never do).
    logger.warn("usage.write.error", { organizationId, requestId, message: error instanceof Error ? error.message : String(error) });
  }
}
