# ADR-016 — Service Scope Model

- **Estado:** Accepted
- **Data:** 2026-09-22

## Context
Na Pista is both a Platform API *consumer* (outbound: entitlements, usage, events — OD-11) and, for any
integration a tenant or another UL application makes directly to Na Pista, a *resource server* (inbound). It
needs a consistent, provable answer to "what may this specific credential do" on both sides, using the
Platform's existing Service Scopes registry rather than inventing a parallel one.

## Decision
**Inbound**, Na Pista never verifies a `ulk_...` credential itself — it cannot; only the Platform holds the
secret hash (PG-11). It introspects via the Platform's own `GET /v1/service/me`
(`src/platform/serviceIntrospection.ts`), caches the result briefly, and gates each route with
`requireScope`/`requireAuthorized`, reusing the Platform's already-seeded scope vocabulary for `NA_PISTA`
(`catalog.read`, `catalog.write`, `customer.read` — no new scopes invented for this spike).
**Outbound**, Na Pista's own credential (OD-11, "platform-facing" class) carries only `usage.write` and
`event.publish` — never the data scopes a tenant's own integration key would carry, and never mixed into the
same credential (`authorization.md` §3.1).

## Alternatives
- A Na-Pista-local scope registry, independent of the Platform's — rejected: would duplicate the Platform's
  `service_scopes`/`application_service_scopes` model for no benefit; the Platform's registry already
  constrains exactly what a `NA_PISTA` credential may ever be granted.
- One credential class per organization instead of two — rejected (PG-8: the Platform lets an OWNER mint any
  allowlisted scope on one key; separating classes is what keeps a tenant's own integration key from ever
  also being Na Pista's own usage/event-publishing identity).

## Consequences
- (+) Scope checks are proven live for every case F19 §15/§22 lists: valid+sufficient (200), revoked (401),
  expired (401), insufficient scope (403), wrong-organization credential (403), unknown credential (401).
- (+) No new Platform surface needed — reuses `GET /v1/service/me` and the existing `NA_PISTA` scope allowlist
  exactly as seeded.
- (−) Two credentials to manage per organization instead of one (see ADR-011's operational consequences).

See `docs/decisions.md` §OD-11 and `tests/e2e/service-auth.test.ts` for the full runtime evidence.
