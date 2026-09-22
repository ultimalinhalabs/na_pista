import { callPlatform } from "./client.js";
import { UnauthorizedError } from "../shared/errors.js";

/**
 * The INBOUND half of service authentication (F19 §6/§7): when something
 * else (a tenant's own integration, or another UL application) calls Na
 * Pista with a `ulk_...` credential, Na Pista does not — and structurally
 * cannot — verify it itself (PG-11, platform-audit.md): only the Platform
 * holds the secret hash. Na Pista introspects it via the Platform's own
 * `GET /v1/service/me`, exactly as any other resource server would.
 */
export interface ServiceIdentity {
  apiKeyId: string;
  application: string;
  organizationId: string | null;
  scopes: string[];
}

interface CacheEntry {
  value: ServiceIdentity;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 15_000; // OD-13: same short-TTL posture as membership — a revoked key stays usable at most this long.

export function _clearServiceIdentityCache() {
  cache.clear();
}

export async function introspectServiceCredential(credential: string, requestId?: string): Promise<ServiceIdentity> {
  const cached = cache.get(credential);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const res = await callPlatform<ServiceIdentity>("GET", "/service/me", { token: credential, requestId });
  if (res.status !== 200 || !res.data) {
    // Unknown id, wrong secret, revoked, expired, or owning application
    // not ACTIVE all collapse to the same generic outcome here too —
    // mirroring the Platform's own verifyApiKeyToken posture (never let a
    // response distinguish *why* a credential failed).
    throw new UnauthorizedError("Invalid, revoked or expired service credential");
  }

  const identity = res.data;
  cache.set(credential, { value: identity, expiresAt: Date.now() + TTL_MS });
  return identity;
}
