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
}

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
  cache.set(credential, { value: identity, expiresAt: Date.now() + TTL_MS });
  return identity;
}
