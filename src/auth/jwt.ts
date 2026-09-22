/**
 * ADR-012 (F19): Na Pista does not verify Supabase JWT signatures locally
 * — the Platform's own `GET /v1/me` re-verifies on every cache miss
 * (platform/membership.ts), and this project's Supabase configuration
 * signs with the legacy shared HS256 secret, which Na Pista must never
 * hold (it would be a second copy of a Platform secret). See
 * na-pista/docs/decisions.md ADR-012 for the full rationale.
 *
 * What this module does, with no network call and no secret: a cheap,
 * local shape/expiry pre-check — a fast-fail path that can only reject,
 * never accept, on its own.
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
    return JSON.parse(payloadJson) as DecodedShape;
  } catch {
    return null;
  }
}

export function isObviouslyExpired(shape: DecodedShape | null): boolean {
  if (!shape?.exp) return false; // unknown -> let the Platform decide, don't guess
  return shape.exp * 1000 < Date.now();
}
