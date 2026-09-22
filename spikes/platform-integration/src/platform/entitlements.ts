import { callPlatform } from "./client.js";
import { getServiceCredential } from "./serviceAuth.js";
import { UpstreamUnavailableError } from "../shared/errors.js";

/**
 * ADR-014 / entitlements.md: Na Pista consumes the Platform's Effective
 * Entitlements resolution; it never re-implements Plan/Subscription
 * resolution itself. Interpretation (§ below) is a pure function, unit
 * tested without any network call — only the fetch is I/O.
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
 * Pure interpretation of one raw entitlements response for one capability
 * key. Fail-closed rules (F19 §12/§20, entitlements.md §3):
 *  - no granting subscription at all            -> disabled
 *  - key absent from the resolved list          -> disabled (never "assume enabled")
 *  - value === false                            -> disabled
 *  - value === true                             -> enabled
 *  - value is a finite number                   -> enabled IS a category error for a boolean-shaped
 *    capability key; treated as invalid -> disabled (a numeric key like
 *    products.max is read through `readLimit`, never through this function)
 *  - anything else (string, object, null, NaN)  -> invalid -> disabled
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

/** Same fail-closed posture for a numeric limit key (e.g. products.max). Non-finite-number values are treated as "no usable limit" — never silently coerced. */
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
const TTL_MS = 10_000; // OD-13: short — see docs/decisions.md for the measured before/after-TTL behavior.

export function _clearEntitlementsCache() {
  cache.clear();
}

/**
 * Fetches (or serves from short-TTL cache) the raw effective entitlements
 * for one organization, using THIS organization's own Na Pista service
 * credential (OD-11) — never a human token, never a platform-wide
 * credential (none exists to use — see ADR-011).
 */
export async function fetchEntitlements(organizationId: string, requestId?: string): Promise<RawEntitlementsResponse> {
  const cacheKey = organizationId;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const credential = getServiceCredential(organizationId);
  if (!credential) {
    // No provisioned credential for this org at all -> cannot prove
    // access -> fail closed, never "assume enabled".
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

  cache.set(cacheKey, { value: res.data, expiresAt: Date.now() + TTL_MS });
  return res.data;
}
