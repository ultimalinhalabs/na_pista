# ADR-027 — Inventory Model

- **Estado:** Accepted — implemented, migrated against real PostgreSQL
- **Data:** 2026-09-23
- **Closes:** OD-04 (units/fractional quantities), OD-06 (locations), for this slice's scope

## Context
F18 left three inventory-adjacent decisions open: OD-04 (units of measure / fractional quantities), OD-05
(negative stock — closed separately in ADR-028), OD-06 (locations/warehouses). F22 required Na Pista's first
real Inventory domain, and the brief was explicit: do not silently invent answers, close what this slice
needs, document it, keep it simple enough to change later.

## Decision

**Quantity (OD-04, part 1):** `numeric(20,6)` — precise decimal, never a Postgres float, never raw JS
floating-point math on the way to persistence. The API accepts a JSON number or a decimal string (mirroring
`ul-platform`'s own `usage_events.quantity` convention exactly, for the identical reason: a JSON number is an
IEEE-754 double, so round-tripping a large/precise value through one would reintroduce the imprecision
`numeric(20,6)` exists to avoid) and always normalizes to a fixed 6-decimal string before it reaches Postgres.

**Unit of measure (OD-04, part 2):** a minimal fixed enum — `UNIT | KG | G | L | ML` — **on `Product`, not on
Inventory.** It is an intrinsic property of the thing being measured ("this product is always counted in kg"),
never something that varies per inventory record or changes independently of the product; putting it on
Inventory would duplicate the concept across two tables for no reason. No unit-conversion engine, no
per-organization custom units — this is explicitly not "SAP in TypeScript" (F22 brief §5).

**Locations (OD-06):** **deferred — one logical balance per (Organization, Product), full stop.**
`UNIQUE(organization_id, product_id)` on `inventory_balances` is the enforced invariant; no
`warehouse`/`location`/`stock_location` table exists. Nothing in Na Pista's current scope (a single-location
boutique/barbershop/hybrid business, per F18's own scenarios) demonstrates a need for multi-location — adding
it speculatively is exactly what F18 §14 and F22 §2 both rule out. If a real multi-location requirement
appears later, the natural extension is additive: a `location_id` column and widening the unique constraint to
`(organization_id, product_id, location_id)` — not a redesign.

**Balance vs. history, kept separate (F22 brief §9):** `inventory_balances` holds only the current quantity;
`stock_movements` is the append-only ledger. The balance is never the only record of truth — every change to
it is provable from a corresponding movement row (see ADR-028).

**Lazy creation (F22 brief §14):** no `inventory_balances` row is created when a Product is created. A balance
only comes into existence on the first `RECEIPT`. Avoids a zero-quantity row for every product that has never
been stocked — most products in a fresh organization, most of the time.

**Tenant-safe Product relationship (F22 brief §8):** both `inventory_balances` and `stock_movements` use the
exact composite-FK pattern ADR-021 already established for `products → categories`:
`(organization_id, product_id) → products(organization_id, id)`. A product from Organization B can never
receive inventory belonging to Organization A — proven structurally by Postgres, not just application code
(see `tests/integration/inventory.test.ts`).

## Alternatives
A `unit` table / full UOM engine with conversion factors — rejected, no requirement justifies it (F22 brief
§5 explicitly warns against it). Locations/warehouses now — rejected (OD-06 above). Storing `unit` on
`InventoryBalance` instead of `Product` — rejected: would let two inventory records for the same product
disagree about what unit they're in, which makes no domain sense, and duplicates a concept already on Product.

## Consequences
- (+) The schema directly expresses "one truth about how much of this product exists right now, and a
  complete, tamper-evident history of how it got there."
- (+) Every future extension named above (locations, richer UOM) is additive, not a migration that breaks the
  existing shape.
- (−) A business that genuinely operates multiple physical locations is not served by this slice — explicitly
  deferred, not silently ignored.
