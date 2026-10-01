import { env } from "../../config/env.js";
import { getServiceCredential } from "../../platform/serviceAuth.js";
import { CredentialCryptoError, decryptCredential } from "../../security/credentialCrypto.js";
import { getCredentialEncryptionKey } from "../../security/credentialKey.js";
import { UpstreamUnavailableError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { OrganizationPlatformCredentialRow } from "../../db/schema/index.js";
import { findCurrentCredential } from "./repository.js";

/**
 * F29A: THE single server-side entry point that turns an organization into
 * the plaintext Platform credential Na Pista calls the Platform with. Only
 * `src/platform/*` calls it; the plaintext goes straight into the
 * Authorization header of the outbound request and is never returned by
 * any route, logged, or stored anywhere else.
 *
 * Organization context: callers pass `req.tenant.organizationId`, which
 * `tenancy/tenantContext.ts` only sets after cross-checking the path
 * segment against the caller's real membership/credential — this function
 * never receives a raw, unvalidated client value.
 *
 * Fail closed (ADR-017): a missing, REVOKED, undecryptable or unloadable
 * credential — or a missing key — never results in a Platform request.
 * Every failure is the same generic 503 to the client (the code this
 * path always returned); the specific reason goes to the log as a code
 * only, never with key material, ciphertext or plaintext.
 */
export type CredentialFailureReason =
  | "INVALID_ORGANIZATION"
  | "NOT_PROVISIONED"
  | "REVOKED"
  | "KEY_MISSING"
  | "DECRYPTION_FAILED"
  | "STORE_UNAVAILABLE";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PlatformCredentialUnavailableError extends UpstreamUnavailableError {
  constructor(public readonly reason: CredentialFailureReason) {
    super("Platform credential unavailable for this organization");
    this.name = "PlatformCredentialUnavailableError";
  }
}

export interface ResolveOptions {
  requestId?: string;
  /** Test seam only — production always uses the env key. */
  key?: () => Buffer;
}

function fail(organizationId: string, reason: CredentialFailureReason, requestId?: string): never {
  logger.warn("platform_credential.unavailable", { organizationId, reason, requestId });
  throw new PlatformCredentialUnavailableError(reason);
}

/**
 * Short-lived cache of the persisted ROW (ciphertext + status) — never of the
 * plaintext, which is still decrypted per call and never outlives it.
 * Without it every Platform call (including the usage write after each
 * mutation) paid an extra database round trip: measured +21% on a
 * write-heavy E2E suite against the remote database (docs/f29a-report.md §15).
 *
 * TTL = the entitlement cache's 10s (OD-13), so the window in which a
 * revocation made by ANOTHER process can still go unnoticed is unchanged.
 * Revocation/provisioning in this process invalidates immediately; one
 * made by another process takes effect within the same TTL. "No row" is
 * cached too (organizations without a persisted credential — e.g. those
 * served by the non-production test override — would otherwise pay a
 * database round trip on every Platform call). A failed lookup (database
 * unavailable) is never remembered.
 */
const ROW_TTL_MS = 10_000;
const rowCache = new Map<string, { row: OrganizationPlatformCredentialRow | undefined; expiresAt: number }>();

export function invalidatePlatformCredentialCache(organizationId?: string) {
  if (organizationId) rowCache.delete(organizationId);
  else rowCache.clear();
}

async function loadRow(organizationId: string): Promise<OrganizationPlatformCredentialRow | undefined> {
  const cached = rowCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.row;
  const row = await findCurrentCredential(organizationId); // throws on DB failure → nothing cached
  rowCache.set(organizationId, { row, expiresAt: Date.now() + ROW_TTL_MS });
  return row;
}

export async function resolvePlatformCredential(organizationId: string, opts: ResolveOptions = {}): Promise<string> {
  const { requestId } = opts;
  if (!UUID.test(organizationId)) fail(organizationId, "INVALID_ORGANIZATION", requestId);

  let row;
  try {
    row = await loadRow(organizationId);
  } catch {
    // Driver/connection errors can carry connection details — never forwarded.
    fail(organizationId, "STORE_UNAVAILABLE", requestId);
  }

  if (!row) {
    // Test/dev-only override (src/platform/serviceAuth.ts): consulted ONLY
    // when the database has no row at all for this organization, and never
    // in production. A persisted REVOKED row can therefore never be bypassed.
    if (env.NODE_ENV !== "production") {
      const override = getServiceCredential(organizationId);
      if (override) return override;
    }
    fail(organizationId, "NOT_PROVISIONED", requestId);
  }

  if (row.status !== "ACTIVE") fail(organizationId, "REVOKED", requestId);

  try {
    const key = (opts.key ?? getCredentialEncryptionKey)();
    return decryptCredential(row.encryptedCredential, organizationId, key);
  } catch (error) {
    const reason: CredentialFailureReason =
      error instanceof CredentialCryptoError && (error.reason === "KEY_MISSING" || error.reason === "KEY_INVALID")
        ? "KEY_MISSING"
        : "DECRYPTION_FAILED";
    fail(organizationId, reason, requestId);
  }
}
