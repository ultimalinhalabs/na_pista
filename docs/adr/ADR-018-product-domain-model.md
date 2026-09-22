# ADR-018 — Product Domain Model

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F20 needed the first real business module. F18's `domain-model.md` had already resolved most Product-domain
open decisions (PD-1..PD-8) at a conceptual level; F20 had to turn the CORE subset into real, tenant-scoped
Postgres tables and a real API without inventing anything PD-3/PD-4/PD-6/PD-7 had left open.

## Decision
Minimal `Product`: `id, organizationId, categoryId (optional), name, description, status, createdAt, updatedAt`.
No `price` — F18's OD-01 (currency/decimalization) is still open, and this slice's own form (F20 brief §24) never
asked for one. No variants, inventory, barcode, SKU, suppliers, warehouses — all explicitly deferred
(`modules.md`). `status`: `ACTIVE | ARCHIVED` only (see ADR-020).

## Alternatives
Adding a minimal price field anyway "for realism" — rejected: F20 brief §6 is explicit ("antes de adicionar
price: verificar OD-01... não inventar um modelo financeiro"), and OD-01 is still open. Adding it would mean
guessing currency/decimal precision now and probably migrating it later.

## Consequences
- (+) Nothing here blocks the real price model once OD-01 closes — `price_minor`/`currency_code` are additive
  columns, not a redesign.
- (+) Proven end to end: create/read/update/archive, tenant isolation, category relation, audit, usage — all
  green against real Postgres + real Platform (`docs/f20-report.md` §Tests).
- (−) The module cannot yet represent anything commerce needs price for (Orders — explicitly out of scope,
  F20 brief §32).
