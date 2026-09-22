# ADR-021 — Tenant-scoped Repository

- **Estado:** Accepted — implemented and E2E/integration-tested
- **Data:** 2026-09-22

## Context
F19's spike already proved the pattern (ADR-002/ADR-015); F20 had to apply it for real, for two modules, with
a real relation between them (Product → Category), and prove it holds under an actual composite foreign key,
not just an application-level filter.

## Decision
Four layers, unchanged from F19, now doubled for Category and Product:
1. `organization_id NOT NULL` on every table.
2. Composite indexes/constraints: `UNIQUE(organization_id, id)` on both `categories` and `products`, and a
   composite FK `products(organization_id, category_id) -> categories(organization_id, id)` — a product can
   be constructed to reference a wrong-organization category **only if Postgres itself would refuse the
   insert**, not merely because the application code happens to check first.
3. A repository (`modules/*/repository.ts`) that cannot run without a `TenantContext` — a synchronous guard
   (`assertTenant`) that throws before any query, unit-tested directly (`tests/unit/repository.test.ts`) for
   both modules.
4. A service layer (`modules/*/service.ts`) that validates a *referenced* resource's tenant (categoryId)
   before ever reaching the database, turning what would otherwise be a raw FK-violation 500 into a clean 400
   `VALIDATION_ERROR` — proven in `tests/e2e/category-and-product-lifecycle.test.ts` ("a non-existent... categoryId
   is rejected with a clean 400, not a raw FK error").

The composite FK was proven to actually fire — not just assumed — by a real integration test
(`tests/integration/tenant-isolation.test.ts`, "composite FK: a product cannot reference a category from a
different organization") that inserts directly through the repository layer (bypassing the service-layer
pre-check entirely) and asserts Postgres rejects it.

## Alternatives
Trusting the service-layer pre-check alone, without the composite FK — rejected: that would make correctness
depend on every future code path remembering to call `assertCategoryBelongsToTenant` before inserting/updating
a `categoryId`. The FK makes it structurally impossible regardless of which code path is used.

## Consequences
- (+) Two independent enforcement layers for the one relationship in this slice that could leak across
  tenants (Product → Category) — proven by tests that exercise each layer separately.
- (+) The pattern is now proven for a *relation*, not just a flat resource — the template the next module
  (e.g. Services → Professionals) can copy directly.
- (−) Composite FKs mean every future tenant-scoped table that references another tenant-scoped table must
  remember to add `UNIQUE(organization_id, id)` on the target and the composite FK on the source — a real,
  recurring discipline cost, not automated away.
