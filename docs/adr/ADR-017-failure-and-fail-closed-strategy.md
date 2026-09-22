# ADR-017 — Failure and Fail-Closed Strategy

- **Estado:** Accepted
- **Data:** 2026-09-22

## Context
Na Pista depends on the Platform (membership, entitlements, service introspection) and on its own database on
every protected request. F19 §19/§20 require an explicit, tested answer for every failure mode, not an
implicit one discovered in production.

## Decision
**Fail closed** for every security-relevant dependency, **always** surfaced as a typed error with its own
code, never a bare 500 and never a silent "allow":

| Failure | Surfaced as | Where |
|---|---|---|
| Platform unreachable / timeout (any call) | `503 UPSTREAM_UNAVAILABLE` | `platform/client.ts` (3s hard timeout via `AbortController`, every network/parse failure normalized to the same error) |
| No service credential provisioned for an organization | `503 UPSTREAM_UNAVAILABLE` | `platform/entitlements.ts` — distinct from "entitlement absent" (`403`) |
| Invalid/expired/unknown JWT or service credential | `401 UNAUTHORIZED` | `middleware/authenticate.ts`, both branches |
| No membership / missing permission / missing scope / entitlement disabled | `403 FORBIDDEN` / `403 ENTITLEMENT_REQUIRED` | `tenancy/tenantContext.ts`, `middleware/requireAuthorized.ts`, `middleware/requireCapability.ts` |
| Cross-tenant id lookup | `404 NOT_FOUND` (never `403`, never the row) | `modules/products/repository.ts`/`service.ts` |
| Repository called without a resolved tenant | hard synchronous throw, never a query | `modules/products/repository.ts`'s `assertTenant` |
| Na Pista's own database unreachable | `503 UPSTREAM_UNAVAILABLE` (mapped from the raw driver error, never leaked) | `middleware/errorHandler.ts`'s `isConnectionError` |

**Degrade gracefully is explicitly reserved** for exactly what F19 §20 names as safe to degrade — telemetry
and analytics — neither of which this spike builds (no metrics/analytics pipeline exists yet to degrade).
Nothing security-relevant in this spike has a "degrade" path; everything above is binary: succeed with full
verification, or fail closed with a typed error.

## Alternatives
- Treat a Platform timeout as "no entitlement" (effectively same as disabled) — rejected: conflates "we don't
  know" with "we know the answer is no", which would make a real outage look identical to a real business
  decision in logs/metrics, and would make the two impossible to alert on differently.
- A generic 500 for all upstream failures — rejected: indistinguishable from a real bug, and (for DB errors)
  risks leaking driver/connection details if not explicitly mapped (`isConnectionError` exists specifically to
  prevent this — proven in `tests/e2e/own-db-unavailable.test.ts`, which asserts the connection string never
  appears in the response).

## Consequences
- (+) Every failure mode F19 §19 lists has a proven, typed, tested outcome (`tests/e2e/platform-unavailable.test.ts`,
  `tests/e2e/own-db-unavailable.test.ts`, plus the auth/service-auth/entitlements suites for the credential-
  and-permission-shaped failures).
- (+) `UPSTREAM_UNAVAILABLE` is a single, greppable signal for "something we depend on is down" across both
  the Platform and Na Pista's own database — useful for alerting later.
- (−) A Platform blip now means real users see `503`s for security-gated operations rather than a cached
  best-effort "probably fine" — a deliberate tradeoff (correctness over availability for security decisions),
  consistent with CLAUDE.md §11 "if a security-sensitive decision is ambiguous, stop and flag it rather than
  silently choosing an unsafe implementation."

See `docs/decisions.md` and `docs/f19-report.md` §12 for the full security test matrix.
