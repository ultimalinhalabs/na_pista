# ADR-019 — Category Model

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F18's `domain-model.md` PD-2 left the category hierarchy question open ("flat in slice 1, `parentId` only when
a real requirement shows up"). F20 needed a real decision to ship.

## Decision
Flat categories: `id, organizationId, name, description (optional), status, createdAt, updatedAt`. No
`parentId`, no tree. No global categories — every category belongs to exactly one Organization
(`tenancy.md`/CLAUDE.md §2). `status: ACTIVE | ARCHIVED` mirrors Product's (ADR-020) for the same reason:
DELETE archives, never deletes physically (F20 brief §5's "antes de decidir DELETE físico vs soft delete:
analisar dependências" — a Category can be referenced by Products via the composite FK; physically deleting
one would either cascade-orphan every product's `categoryId` or require `ON DELETE RESTRICT`/`SET NULL`
semantics to be decided under time pressure — archiving sidesteps the question entirely and is reversible).

## Alternatives
A `parentId` tree — rejected now (no real requirement demonstrated it; adding it later is additive, per F18's
own OD-08 recommendation). Physical DELETE with `ON DELETE RESTRICT` from products — rejected: would make
deleting a category a hard error whenever any product (including archived ones) references it, forcing the
caller to first hunt down and reassign every product — worse UX than archiving for no real benefit at this
scale.

## Consequences
- (+) Composite FK (`products_category_org_fk`) is exactly what makes ADR-021's cross-tenant guarantee real —
  proven with a real Postgres FK violation in `tests/integration/tenant-isolation.test.ts`.
- (+) An archived category's products keep their `categoryId` intact — no orphaning, no cascade surprises.
- (−) No hierarchy — a business that genuinely needs nested categories (e.g. "Bebidas > Refrigerantes") isn't
  served yet; deferred until demonstrated.
