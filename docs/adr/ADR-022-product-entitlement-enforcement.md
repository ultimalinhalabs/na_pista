# ADR-022 — Product Entitlement Enforcement

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F19's OD-14 already decided the interim vocabulary (`catalog.enabled`, reusing the Platform's real seed
instead of inventing `products.enabled`). F20 had to actually wire it to real routes and prove, live, that
disabling and re-enabling it changes real behavior.

## Decision
Both Categories and Products routes are gated by the same single capability key, `catalog.enabled`
(`middleware/requireCapability.ts`, unchanged from the F19 spike) — the whole module is one commercial unit
for this slice, not two independently-toggleable ones (a business either has Product Management or it
doesn't; splitting Products from Categories behind separate entitlements was not asked for and would need its
own justification). The Platform's `NA_PISTA/BUSINESS` plan already grants `catalog.enabled` — no seed change
was needed to prove this.

**Proven live** (`tests/e2e/entitlements.test.ts`), against the real Platform: a subscribed organization can
create products (`201`); an organization with no subscription at all is rejected (`403 ENTITLEMENT_REQUIRED`,
distinct from the `503` an organization with no *registered service credential* gets — two different failure
modes, never conflated); and — the strongest proof — a **live cancel-then-resubscribe cycle** on a real
Platform subscription toggles real Na Pista behavior from allowed to blocked and back to allowed, within the
same test run.

## Alternatives
A separate `products.enabled`/`categories.enabled` pair — rejected: no product requirement justifies splitting
them yet; F19's ADR-014 already established the principle of not inventing entitlement keys without a real
need. `products.max` (already seeded, numeric) was considered for this slice's create path but deliberately
**not wired** — F20 didn't ask for a limit-enforcement demonstration, and the F19 spike already proved the
mechanism (`entitlements.md` §5); wiring it here without a concrete requirement would be speculative.

## Consequences
- (+) One capability check, one code path (`requireCapability`), reused identically by both modules — no
  divergent gating logic to keep in sync.
- (+) The live toggle test is real evidence the *whole chain* — Subscription → Plan → Plan Entitlement →
  Effective Entitlement → Na Pista's own cache → route gate — works end to end, not just each link in
  isolation (which F19 already proved).
- (−) `products.max` is not enforced in this slice — an organization could create unboundedly many products.
  Documented as a known limitation (`docs/f20-report.md`), not silently accepted as fine forever.
