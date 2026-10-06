import { callPlatform } from "./client.js";
import { AccountDisabledError, UnauthorizedError } from "../shared/errors.js";

/**
 * OD-12 (F19, CLOSED): resolves "who is this user, and what is their
 * membership in this organization" by forwarding the user's own JWT to
 * the Platform's GET /v1/me — never by decoding/trusting the token
 * ourselves, never by copying membership into Na Pista's own database.
 *
 * Fase 6 (UL Platform): the Platform also reports the user's status, each
 * organization's status and the organization's application access with the
 * member's effective application role. Na Pista only READS these — it never
 * keeps a parallel authority. The new fields are optional so Na Pista keeps
 * working against a Platform that does not send them yet.
 */
export interface PlatformMembership {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  roleKey: string;
  status: "active" | "invited" | "suspended";
  organization?: { id: string; name: string; slug: string; status: "active" | "suspended" };
  applications?: Array<{ key: string; roleKey: string | null; roleSource: "explicit" | "fallback" | null }>;
}

export interface PlatformIdentity {
  userId: string;
  email?: string;
  status?: "active" | "disabled";
  emailVerified?: boolean;
  memberships: PlatformMembership[];
}

interface CacheEntry {
  value: PlatformIdentity;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/**
 * OD-13: short cache — a revoked membership, a disabled user or a suspended
 * organization takes effect within this window, never longer. Fase 6 review:
 * 15 s is kept (a bounded, documented staleness vs. one Platform round-trip
 * per request); see tests/unit/platform-identity-status.test.ts.
 */
export const IDENTITY_CACHE_TTL_MS = 15_000;

export function _clearMembershipCache() {
  cache.clear();
}

export async function resolveIdentity(token: string, requestId?: string): Promise<PlatformIdentity> {
  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const res = await callPlatform<PlatformIdentity>("GET", "/me", { token, requestId });

  // Fase 6 — the Platform refuses a disabled user with 403 ACCOUNT_DISABLED; surface it as such.
  if (res.status === 403 && res.error?.code === "ACCOUNT_DISABLED") {
    throw new AccountDisabledError();
  }
  if (res.status !== 200 || !res.data) {
    throw new UnauthorizedError("Invalid or expired session");
  }
  if (res.data.status === "disabled") {
    throw new AccountDisabledError();
  }

  const identity: PlatformIdentity = res.data;
  cache.set(token, { value: identity, expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS });
  return identity;
}

export function membershipFor(identity: PlatformIdentity, organizationId: string): PlatformMembership | undefined {
  return identity.memberships.find((m) => m.organizationId === organizationId && m.status === "active");
}

/** Fase 6 — only an explicit `suspended` blocks (a Platform that does not report the status yet means active). */
export function isOrganizationSuspended(membership: PlatformMembership): boolean {
  return membership.organization?.status === "suspended";
}

/** Fase 6 — does the organization have UL application access to NA_PISTA (as reported by the Platform)? */
export function hasNaPistaApplicationAccess(membership: PlatformMembership): boolean {
  return (membership.applications ?? []).some((a) => a.key === "NA_PISTA");
}

/**
 * Fase 6 — the role Na Pista authorizes with: the member's NA_PISTA
 * application role when the Platform reports one (explicit, or the
 * Platform's documented fallback — for NA_PISTA the same as the
 * organization role), otherwise the organization role as before.
 */
export function effectiveNaPistaRoleKey(membership: PlatformMembership): string {
  return membership.applications?.find((a) => a.key === "NA_PISTA")?.roleKey ?? membership.roleKey;
}
