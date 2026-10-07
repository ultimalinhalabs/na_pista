import { callPlatform } from "./client.js";
import { OrganizationSuspendedError, UnauthorizedError } from "../shared/errors.js";

/**
 * The INBOUND half of service authentication: when something else (a
 * tenant's own integration, or another UL application) calls Na Pista
 * with a `ulk_...` credential, Na Pista does not — and structurally
 * cannot — verify it itself (only the Platform holds the secret hash).
 * It introspects via the Platform's own `GET /v1/service/me`.
 */
export interface ServiceIdentity {
  apiKeyId: string;
  application: string;
  organizationId: string | null;
  scopes: string[];
  /** D2-B — the credential's structural class, as stated by the Platform. */
  credentialClass?: string;
}

/**
 * D2-B — classes that may call Na Pista INBOUND. An INTEGRATION_MANAGED credential is the one Na Pista
 * itself holds to call the Platform: it is never accepted as a caller of Na Pista (nor is a PENDING one,
 * which only exists in that class). An identity without a class is refused (fail closed).
 */
const INBOUND_CLASSES = new Set(["ORGANIZATION", "PLATFORM_SERVICE"]);

interface CacheEntry {
  value: ServiceIdentity;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 15_000;

export function _clearServiceIdentityCache() {
  cache.clear();
}

export async function introspectServiceCredential(credential: string, requestId?: string): Promise<ServiceIdentity> {
  const cached = cache.get(credential);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const res = await callPlatform<ServiceIdentity>("GET", "/service/me", { token: credential, requestId });
  // Fase 6 — an organization-scoped credential stops working while its UL organization is suspended.
  if (res.status === 403 && res.error?.code === "ORGANIZATION_SUSPENDED") {
    throw new OrganizationSuspendedError();
  }
  if (res.status !== 200 || !res.data) {
    throw new UnauthorizedError("Invalid, revoked or expired service credential");
  }

  const identity = res.data;
  if (!identity.credentialClass || !INBOUND_CLASSES.has(identity.credentialClass)) {
    throw new UnauthorizedError("Invalid, revoked or expired service credential");
  }
  cache.set(credential, { value: identity, expiresAt: Date.now() + TTL_MS });
  return identity;
}
