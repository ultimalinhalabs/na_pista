# ADR-014 — Entitlement Consumption

- **Estado:** Accepted
- **Data:** 2026-09-22
- **Closes:** OD-13, OD-14

## Context
F18's ADR-007 established that Na Pista consumes, never re-implements, the Platform's Effective Entitlements
resolution. F19 had to prove that live and settle the interpretation semantics and the interim vocabulary.

## Decision
`platform/entitlements.ts` fetches `GET /organizations/:id/applications/NA_PISTA/entitlements` with the
organization's own service credential (OD-11), caches the raw response for a short TTL (10s), and interprets
it through pure, unit-tested functions (`interpretCapability`, `readLimit`) that default to **disabled**/**no
usable limit** and only flip to "allow" on an exact match (`value === true`; a finite number for a limit).
Interim vocabulary: gates on the already-seeded `catalog.enabled` key rather than inventing an unseeded
`products.enabled` (OD-14) — no `ul-platform` seed data was changed to run this spike.

## Alternatives
- A second, Na-Pista-side entitlement/plan model — rejected outright (this is exactly what ADR-007 already
  ruled out; F19 re-confirms it by proving the real Platform mechanism works end to end instead).
- Treating an unrecognized/malformed entitlement value as "probably fine, allow it" — rejected (F19 §12/§20's
  explicit fail-closed instruction; every non-exact-match interpretation defaults to disabled).
- Renaming `catalog.enabled` to `products.enabled` in the Platform's real seed data to make the spike's naming
  cleaner — rejected: it would mutate shared, real Platform data (used by real organizations in the same dev
  database) to make a spike's vocabulary tidier. Recorded as optional future Platform work instead
  (`platform-changes-required.md` §PC-4).

## Consequences
- (+) One resolution mechanism, proven live against real Subscription/Plan/PlanEntitlement data (Organization
  A enabled, Organization B with no subscription, Organization C with a canceled one, Organization E
  cancelled live mid-test).
- (+) Every ambiguous or malformed value is provably rejected (`tests/unit/entitlements.test.ts`), not
  assumed safe.
- (−) The interim `catalog.enabled` key is not the target name; a future rename is real (if small) Platform
  work, not yet scheduled.

See `docs/decisions.md` §OD-13/§OD-14 for the full runtime evidence and vocabulary table.
