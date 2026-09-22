/**
 * ADR-012: this spike does NOT verify Supabase JWT signatures locally.
 *
 * Why: this Supabase project signs access tokens with the legacy shared
 * HS256 secret (confirmed against the real running ul-platform — see
 * docs/decisions.md ADR-012 "Evidence"). Verifying that locally would mean
 * Na Pista also holding SUPABASE_JWT_SECRET — a second copy of a Platform
 * secret, widening its blast radius for no benefit, since the Platform
 * already re-verifies the same token on every /v1/me call this spike makes
 * (see platform/membership.ts). A project on modern asymmetric signing
 * (ES256/RS256) could verify locally against the *public* JWKS instead
 * (no secret at all) — see docs/decisions.md ADR-012 for that path, not
 * implemented here because it doesn't match this project's real config.
 *
 * What this module DOES do, with no network call and no secret: a cheap,
 * local shape/expiry pre-check, so an obviously garbage or expired token
 * is rejected before spending a request on the Platform. This is a fast
 * path, never the source of truth — a token that passes this check is
 * still only as valid as the Platform's own verification says it is.
 */
export interface DecodedShape {
  sub?: string;
  exp?: number;
  email?: string;
}

export function decodeShapeOnly(token: string): DecodedShape | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const payload = JSON.parse(payloadJson) as DecodedShape;
    return payload;
  } catch {
    return null;
  }
}

export function isObviouslyExpired(shape: DecodedShape | null): boolean {
  if (!shape?.exp) return false; // unknown -> let the Platform decide, don't guess
  return shape.exp * 1000 < Date.now();
}
