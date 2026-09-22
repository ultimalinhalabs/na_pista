import { callPlatform } from "./client.js";
import { getServiceCredential } from "./serviceAuth.js";
import { UpstreamUnavailableError } from "../shared/errors.js";

/**
 * ADR-014/ADR-022: Na Pista consumes the Platform's Effective Entitlements
 * resolution; it never re-implements Plan/Subscription resolution itself.
 * Interpretation below is a pure function, unit tested without network.
 */
export interface RawEntitlement {
  key: string;
  value: unknown;
}
export interface RawEntitlementsResponse {
  application: { key: string; name: string };
  subscription: { id: string; status: string; planKey: string } | null;
  entitlements: RawEntitlement[];
}

export interface CapabilityDecision {
  enabled: boolean;
  reason: "granting-subscription" | "no-subscription" | "entitlement-false" | "entitlement-missing" | "entitlement-invalid";
  raw: unknown;
}

/**
 * Fail-closed rules (OD-13):
 *  - no granting subscription at all      -> disabled
 *  - key absent from the resolved list    -> disabled (never "assume enabled")
 *  - value === false                      -> disabled
 *  - value === true                       -> enabled
 *  - anything else (string, object, number, null) -> invalid -> disabled
 */
export function interpretCapability(resp: RawEntitlementsResponse | null, key: string): CapabilityDecision {
  if (!resp || !resp.subscription) {
    return { enabled: false, reason: "no-subscription", raw: null };
  }
  const found = resp.entitlements.find((e) => e.key === key);
  if (!found) {
    return { enabled: false, reason: "entitlement-missing", raw: undefined };
  }
  if (found.value === true) {
    return { enabled: true, reason: "granting-subscription", raw: true };
  }
  if (found.value === false) {
    return { enabled: false, reason: "entitlement-false", raw: false };
  }
  return { enabled: false, reason: "entitlement-invalid", raw: found.value };
}

export interface LimitDecision {
  hasLimit: boolean;
  max: number | null;
  raw: unknown;
}

export function readLimit(resp: RawEntitlementsResponse | null, key: string): LimitDecision {
  if (!resp || !resp.subscription) return { hasLimit: false, max: null, raw: null };
  const found = resp.entitlements.find((e) => e.key === key);
  if (!found) return { hasLimit: false, max: null, raw: undefined };
  if (typeof found.value === "number" && Number.isFinite(found.value)) {
    return { hasLimit: true, max: found.value, raw: found.value };
  }
  return { hasLimit: false, max: null, raw: found.value };
}

interface CacheEntry {
  value: RawEntitlementsResponse;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10_000; // OD-13

export function _clearEntitlementsCache() {
  cache.clear();
}

export async function fetchEntitlements(organizationId: string, requestId?: string): Promise<RawEntitlementsResponse> {
  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const credential = getServiceCredential(organizationId);
  if (!credential) {
    throw new UpstreamUnavailableError(`No Na Pista service credential provisioned for organization ${organizationId}`);
  }

  const res = await callPlatform<RawEntitlementsResponse>(
    "GET",
    `/organizations/${organizationId}/applications/NA_PISTA/entitlements`,
    { token: credential, requestId },
  );

  if (res.status !== 200 || !res.data) {
    throw new UpstreamUnavailableError(`Could not resolve entitlements for organization ${organizationId}`);
  }

  cache.set(organizationId, { value: res.data, expiresAt: Date.now() + TTL_MS });
  return res.data;
}
