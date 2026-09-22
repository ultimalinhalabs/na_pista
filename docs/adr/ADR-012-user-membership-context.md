# ADR-012 — Na Pista User/Membership Context

- **Estado:** Accepted
- **Data:** 2026-09-22
- **Closes:** OD-12 (context resolution half)

## Context
A human request arrives at Na Pista with a Supabase-issued JWT. Na Pista must know who the caller is and
whether they have an active membership in the organization named in the URL — without becoming a second
source of truth for either fact.

## Decision
Forward the caller's own JWT to the Platform's `GET /v1/me`; treat a `200` response as the authoritative
identity + membership list, cached per-token with a short TTL (15s in this spike). **Na Pista does not verify
the JWT's signature itself** in this path — no JWKS fetch, no shared HS256 secret held by Na Pista. A cheap
local pre-check (decode without verifying, reject an obviously-expired `exp`) exists only as a fast-fail path
that can reject but never accept on its own.

## Alternatives
- **JWKS/local signature verification** (what a project on modern ES256/RS256 signing would allow without
  any shared secret): rejected for *this* environment specifically because the Supabase project in use signs
  with the legacy shared HS256 secret — verifying locally would mean giving Na Pista a copy of
  `SUPABASE_JWT_SECRET`, a Platform secret, widening its blast radius for a check the Platform already
  performs on every cache-miss call anyway. Revisit if/when this Supabase project moves to asymmetric signing.
- **A dedicated Platform endpoint for "look up user X's membership in org Y"**: real Platform work, not built
  — see `platform-changes-required.md` §PC-3.
- **Copy membership into Na Pista's own database**: rejected in F18 (ADR-002) and reaffirmed — a second
  source of truth for authorization is exactly what CLAUDE.md §7 rules out.

## Consequences
- (+) The Platform remains the single source of truth for "who is this, and are they a member"; no sync job,
  no drift.
- (+) No Platform change needed.
- (−) Revocation is bounded by the cache TTL, never instant — measured live, documented, never silent (see
  `docs/decisions.md` §OD-12/§OD-13).
- (−) One Platform round trip per cache miss; amortized by the TTL, not eliminated.

See `docs/decisions.md` §OD-12 for the full runtime evidence.
