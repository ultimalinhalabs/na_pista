# ADR-070 — One Entitlement per Module (supersedes the "reuse `catalog.enabled`" part of ADR-022)

- **Estado:** Accepted — implemented locally (branch `feature/module-entitlements`; not deployed)
- **Data:** 2026-10-20
- **Origem:** UL ecosystem entitlements audit (`projeto_ul/docs/architecture/ENTITLEMENTS-ECOSYSTEM-AUDIT-2026-10-20.md`), owner-approved recommendations; UL Platform migration 0031

## Context

Since ADR-022 every module (products, categories, stock, orders, customers, services, professionals, schedules,
appointments, audit, settings) was gated on the single `catalog.enabled` entitlement. Enabling the catalog therefore
also enabled services and appointments: it was impossible to sell the catalog without services, or to switch off
appointments without switching off the catalog. The approved Na Pista Crescimento terms (np-tos-001, A2) happen to
include every module, so no customer received something not sold — the defect was structural.

## Decision

| Module | Entitlement (UL, NA_PISTA) | Requires | Routes |
|---|---|---|---|
| catalog | `catalog.enabled` | — | products, categories, inventory |
| orders | `orders.enabled` | catalog (order items are products) | orders |
| customers | `customers.enabled` | — | customers |
| services | `services.enabled` | customers (every appointment has one) | services, professionals, schedules, appointments |
| (organization-wide) | any of the above | — | audit events, organization settings |

- Each router uses `requireModule(<module>)` (or `requireAnyModule()`); a direct API call is refused exactly like a
  hidden menu: 403 `ENTITLEMENT_REQUIRED`. Dependencies are validated by UL on every plan (typed definitions) and
  checked again here.
- `GET /organizations/:id/modules` (permission `modules.read`, every role) tells the Console which modules to show.
  Display only — the API remains the authority.
- UL `access.effective = false` (suspended organization, revoked access, expired/revoked grant) disables everything.
- `products.max` absent → refused (UL definition: absent policy `deny`). Every Na Pista plan sets it.
- **Transition:** a module key that is ABSENT (not `false`) falls back to `catalog.enabled`, so a UL Platform that has
  not yet loaded the per-module keys keeps today's behaviour. Remove this fallback once production plans carry the keys
  (audit §12.5 phase 8). An explicit `false` is always honoured.
- Service-credential scopes stay `catalog.read`/`catalog.write` for every module (unchanged; splitting them is a later,
  separate decision).

## Consequences

- Deploy order: UL Platform 0031 (definitions + per-module keys loaded `true` where `catalog.enabled` was) **before** —
  or together with — this change; thanks to the fallback either order keeps current customers' access.
- Storefront (unpublished branches) gets its own keys (`storefront.enabled`, `storefront.checkout.enabled`), defined in UL
  but in no plan — selling it is a commercial decision.
- Tests: unit (`tests/unit/entitlements.test.ts`), integration (`productPlanLimit`), E2E against a local UL
  (`tests/e2e/module-entitlements.test.ts`, fixtures `ul-platform/scripts/module-entitlements-provision-fixtures.ts`).
