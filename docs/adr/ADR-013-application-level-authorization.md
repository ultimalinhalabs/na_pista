# ADR-013 — Application-level Authorization

- **Estado:** Accepted
- **Data:** 2026-09-22
- **Closes:** OD-12 (permissions half)

## Context
UL Platform has exactly four global roles (`OWNER`/`ADMIN`/`MANAGER`/`STAFF`) and ~20 organization-administration
permissions (`membership.create`, `subscription.manage`, ...) — none of them describe a business operation
like "create a product". Na Pista needs a real authorization decision for its own operations without
inventing product-specific permissions inside the Platform (which CLAUDE.md explicitly rules out) and without
letting any Organization role bypass Na Pista's own checks.

## Decision
Local permissions in Na Pista (`src/authorization/permissions.ts`), a plain map keyed by the Platform's
global `roleKey`. `requirePermission`/`requireAuthorized` (human path) checks this map; `requireScope`
(service path) checks the credential's own granted Platform service scopes — two independent mechanisms,
never merged into one generic check.

## Alternatives
1. **Platform global permissions reused as-is** — rejected: none of them express a business capability; using
   them would either misuse an unrelated permission or force the Platform to grow product-specific ones.
2. **Application-scoped Platform permissions** (a new Platform concept, `NA_PISTA.products.write` granted
   per-membership) — real Platform work, not built (`platform-changes-required.md` §PC-3 covers the closely
   related membership-lookup endpoint; a full application-scoped permission model is a larger, separate
   change and is named here only as a future option, not specified in detail, because no concrete requirement
   for per-user custom permissions has appeared yet).
3. **Na Pista local permissions** (adopted).
4. **Hybrid** — closest description of what was actually built: local permission *definitions*, keyed by a
   Platform-issued *role*. Not a fourth option so much as a more precise name for option 3 as implemented.

## Consequences
- (+) No Platform change needed to close this decision; ships today.
- (+) Roles stay global and simple; each product defines what its own roles can do inside it.
- (−) No per-user custom permissions and no per-organization custom roles — a real business need for either
  would require Platform work (option 2) or a Na Pista-local roles-and-permissions table of its own (a real,
  larger feature, not sketched here).
- (−) Duplicated concept across products: every UL product that needs business-operation authorization will
  build its own local permission map against the same four roles — acceptable duplication (CLAUDE.md keeps
  product logic out of the Platform on purpose) but worth naming as a pattern other products should follow
  the same way, not reinvent differently each time.

See `docs/decisions.md` §OD-12 for the capability matrix and full runtime evidence.
