import { callPlatform } from "./client.js";
import { resolvePlatformCredential } from "../modules/platformCredentials/resolver.js";
import { retireLocalCredentialIfRevoked } from "../modules/platformCredentials/rejection.js";
import { EntitlementRequiredError, UpstreamUnavailableError } from "../shared/errors.js";
import type { PlatformResponse } from "./client.js";

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
  /** UL migration 0031 — absent on older UL versions. `effective: false` = nothing is granted (suspended org, revoked access, expired/revoked grant). */
  access?: { effective: boolean; reason: string | null };
  subscription: { id: string; status: string; planKey: string } | null;
  entitlements: RawEntitlement[];
}

export interface CapabilityDecision {
  enabled: boolean;
  reason: "granting-subscription" | "no-subscription" | "entitlement-false" | "entitlement-missing" | "entitlement-invalid" | "dependency-missing";
  raw: unknown;
}

/**
 * Fail-closed rules (OD-13):
 *  - no granting subscription at all, or UL says access is not effective -> disabled
 *  - key absent from the resolved list    -> disabled (never "assume enabled")
 *  - value === false                      -> disabled
 *  - value === true                       -> enabled
 *  - anything else (string, object, number, null) -> invalid -> disabled
 */
export function interpretCapability(resp: RawEntitlementsResponse | null, key: string): CapabilityDecision {
  if (!resp || !resp.subscription || resp.access?.effective === false) {
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

/**
 * Audit 2026-10-20 / UL migration 0031 — one entitlement per module instead of `catalog.enabled` for everything:
 *  - catalog   = products, categories, stock        (catalog.enabled)
 *  - orders    = orders                             (orders.enabled; requires catalog — order items are products)
 *  - customers = customers                          (customers.enabled)
 *  - services  = services, professionals, schedules, appointments (services.enabled; requires customers — every appointment has one)
 * Dependencies are validated by UL on every plan, and checked again here (defence in depth).
 *
 * TRANSITION (remove once every plan in production carries the per-module keys — audit §12.5 phase 8): a module
 * key that is ABSENT (not false) falls back to `catalog.enabled`, so a UL Platform that has not yet loaded the
 * new keys keeps today's behaviour. An explicit `false` is always honoured.
 */
export const MODULE_KEYS = {
  catalog: "catalog.enabled",
  orders: "orders.enabled",
  customers: "customers.enabled",
  services: "services.enabled",
} as const;
export type ModuleName = keyof typeof MODULE_KEYS;
export const MODULE_NAMES = Object.keys(MODULE_KEYS) as ModuleName[];
const MODULE_REQUIRES: Record<ModuleName, ModuleName[]> = { catalog: [], orders: ["catalog"], customers: [], services: ["customers"] };

export function interpretModule(resp: RawEntitlementsResponse | null, module: ModuleName): CapabilityDecision & { legacyFallback: boolean } {
  let decision = interpretCapability(resp, MODULE_KEYS[module]);
  let legacyFallback = false;
  if (module !== "catalog" && decision.reason === "entitlement-missing") {
    decision = interpretCapability(resp, MODULE_KEYS.catalog);
    legacyFallback = true;
  }
  if (!decision.enabled) return { ...decision, legacyFallback };
  for (const required of MODULE_REQUIRES[module]) {
    if (!interpretModule(resp, required).enabled) return { enabled: false, reason: "dependency-missing", raw: decision.raw, legacyFallback };
  }
  return { ...decision, legacyFallback };
}

/** Which modules the organization's plan enables — what the Console shows. */
export function enabledModules(resp: RawEntitlementsResponse | null): Record<ModuleName, boolean> {
  return Object.fromEntries(MODULE_NAMES.map((m) => [m, interpretModule(resp, m).enabled])) as Record<ModuleName, boolean>;
}

export interface LimitDecision {
  hasLimit: boolean;
  max: number | null;
  raw: unknown;
}

export function readLimit(resp: RawEntitlementsResponse | null, key: string): LimitDecision {
  if (!resp || !resp.subscription || resp.access?.effective === false) return { hasLimit: false, max: null, raw: null };
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

/**
 * A non-200 answer to the entitlements read, as an error. UL Platform refuses the organization's credential with
 * 403 when the organization has NO current commercial authority for Na Pista (CREDENTIAL_NOT_AUTHORIZED — e.g. the
 * contract expired or was terminated — or APPLICATION_ACCESS_REQUIRED): that is "the subscription does not include
 * this module" (403 ENTITLEMENT_REQUIRED), not an outage. Anything else stays a fail-closed 503.
 */
export function entitlementsRefusal(res: Pick<PlatformResponse<unknown>, "status" | "error">, organizationId: string): Error {
  if (res.status === 403 && (res.error?.code === "CREDENTIAL_NOT_AUTHORIZED" || res.error?.code === "APPLICATION_ACCESS_REQUIRED")) {
    return new EntitlementRequiredError("The organization has no active subscription to Na Pista");
  }
  return new UpstreamUnavailableError(`Could not resolve entitlements for organization ${organizationId}`);
}

export async function fetchEntitlements(organizationId: string, requestId?: string): Promise<RawEntitlementsResponse> {
  const cached = cache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  // F29A: persisted, encrypted, per-organization credential — fails closed
  // (503, no Platform request sent) if missing, revoked or undecryptable.
  const credential = await resolvePlatformCredential(organizationId, { requestId });

  const res = await callPlatform<RawEntitlementsResponse>(
    "GET",
    `/organizations/${organizationId}/applications/NA_PISTA/entitlements`,
    { token: credential, requestId },
  );

  if (res.status !== 200 || !res.data) {
    // D2-B — fail closed; additionally retire the local copy when the Platform says the credential is revoked.
    await retireLocalCredentialIfRevoked(organizationId, credential, res, requestId);
    throw entitlementsRefusal(res, organizationId);
  }

  cache.set(organizationId, { value: res.data, expiresAt: Date.now() + TTL_MS });
  return res.data;
}
