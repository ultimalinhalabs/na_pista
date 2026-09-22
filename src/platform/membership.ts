import { callPlatform } from "./client.js";
import { UnauthorizedError } from "../shared/errors.js";

/**
 * OD-12 (F19, CLOSED): resolves "who is this user, and what is their
 * membership in this organization" by forwarding the user's own JWT to
 * the Platform's GET /v1/me — never by decoding/trusting the token
 * ourselves, never by copying membership into Na Pista's own database.
 */
export interface PlatformMembership {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  roleKey: string;
  status: "active" | "invited" | "suspended";
}

export interface PlatformIdentity {
  userId: string;
  email?: string;
  memberships: PlatformMembership[];
}

interface CacheEntry {
  value: PlatformIdentity;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 15_000; // OD-13: short cache — a revoked membership takes effect within this window, never longer.

export function _clearMembershipCache() {
  cache.clear();
}

export async function resolveIdentity(token: string, requestId?: string): Promise<PlatformIdentity> {
  const cached = cache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const res = await callPlatform<{ userId: string; email?: string; memberships: PlatformMembership[] }>(
    "GET",
    "/me",
    { token, requestId },
  );

  if (res.status !== 200 || !res.data) {
    throw new UnauthorizedError("Invalid or expired session");
  }

  const identity: PlatformIdentity = res.data;
  cache.set(token, { value: identity, expiresAt: Date.now() + TTL_MS });
  return identity;
}

export function membershipFor(identity: PlatformIdentity, organizationId: string): PlatformMembership | undefined {
  return identity.memberships.find((m) => m.organizationId === organizationId && m.status === "active");
}
