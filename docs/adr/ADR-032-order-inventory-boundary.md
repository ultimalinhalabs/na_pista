# ADR-032 — Order Lifecycle and the Order/Inventory Boundary

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F23A (spike)

## Context
ADR-028 (F22) deliberately kept `StockMovement.type` to `RECEIPT | ADJUSTMENT_IN | ADJUSTMENT_OUT` and
explicitly said: *"No `SALE`/`ORDER_RESERVATION`/`RETURN`/`TRANSFER`/... — those imply Order/Purchasing
workflows that do not exist yet; a future Orders module defines its own stock semantics against this same
ledger rather than this slice guessing them."* F23A is that future module's decision point — but the brief is
explicit (§21/§22/§26): do not implement Orders now, do not invent an Inventory reservation system, and
identify only what F23 can safely build **without modifying the Inventory model**.

## Decision

**Minimum Order lifecycle: `DRAFT → CONFIRMED → COMPLETED`, with `CANCELED` reachable from `DRAFT` or
`CONFIRMED`.**

```
DRAFT ──confirm──► CONFIRMED ──complete──► COMPLETED   (terminal)
  │                    │
  └──cancel──►  CANCELED  ◄──cancel──┘                  (terminal)
```

- **`DRAFT`** — an Order being built (items can be added/removed/changed freely); no Inventory effect.
- **`CONFIRMED`** — the business commits to the sale. **This is the single point Inventory changes** (see
  below). No further item changes once confirmed (an Order's items are only mutable in `DRAFT` — matches
  `OrderItem`'s snapshot semantics: once real stock has moved, the Order's contents must stop changing).
- **`COMPLETED`** — a terminal business-status marker (e.g., "customer received the goods"). **No Inventory
  effect at this transition** — the decrease already happened at `CONFIRMED`; moving it to `COMPLETED` instead,
  or duplicating it at both points, would violate ADR-028's "one movement per real stock event." Payment and
  fulfillment/delivery are explicitly out of scope (Micha Express/Foi own those, CLAUDE.md §4) — `COMPLETED`
  here means only "Na Pista's own record of this sale is done," nothing about money or logistics.
- **`CANCELED`** — terminal. From `DRAFT`: pure state change, no Inventory effect (nothing was ever moved).
  From `CONFIRMED`: the earlier decrease must be reversed (see below).
- No `CONFIRMED → DRAFT` ("un-confirm") — once stock has moved, going back to draft would itself require an
  inventory reversal, which is exactly what cancellation already is; a direct backward transition would be a
  second way to do the same thing.

**Inventory interaction — without modifying the Inventory model, per the brief's explicit constraint.**
`DRAFT → CONFIRMED` records an `ADJUSTMENT_OUT` StockMovement for each `OrderItem` (via the existing
`createMovement` service, unchanged) — the **existing** movement type, no schema change, no new enum value, no
reservation state. `CONFIRMED → CANCELED` records the mirror `ADJUSTMENT_IN` for each item, restoring the
balance — also unchanged, existing behavior. Traceability back to the Order is via the movement's existing
free-text `reason` field (e.g., `"Order {orderId} confirmed"` / `"Order {orderId} canceled"`) — workable for
F23's first cut, but **not** first-class (not queryable/joinable). This is an explicit, named limitation (see
"Consequences"), not an oversight.

**No reservation system.** `DRAFT` never touches Inventory — an Order sitting in `DRAFT` with items that
happen to exceed available stock is not prevented or flagged by Inventory at all; the existing
`INSUFFICIENT_STOCK` check (ADR-028) only fires at the real decrease, i.e., at `CONFIRMED`. Two draft Orders can
reference more of a product than physically exists; only one can successfully confirm. This is a deliberate
scope boundary, not a bug — a real reservation/hold system (time-boxed soft-allocation of stock to a draft) is
a distinct future feature the brief explicitly forbids inventing here (§21/§22).

**Money and Inventory stay separate**, restated concretely: nothing in this ADR adds `inventory.cost`,
`inventory.value`, or any valuation concept to `InventoryBalance`/`StockMovement`. Inventory quantity changes
because of an Order; it never carries or computes the Order's money.

## Alternatives

**Decrease Inventory at `COMPLETED` instead of `CONFIRMED`** — rejected: "confirmed" is the more natural
"the business has committed to this sale" moment for a business without its own delivery/fulfillment tracking
in Na Pista (that belongs to Foi); waiting until `COMPLETED` would let stock apparently remain "available" for
an already-committed sale, which is misleading for any other concurrent Order checking availability.

**A dedicated `SALE` StockMovement type (+ an `orderId` FK column) now** — the *correct* long-term answer
(first-class traceability, queryable "which movements came from which order"), but **explicitly deferred**:
it is an Inventory **schema change**, which the brief instructs F23A specifically not to make (§22: "identify
what F23 can safely implement without modifying the Inventory model"). Named as the clear F24+ extension below.

**A full reservation/hold system for `DRAFT` Orders** — rejected for this phase per the brief's explicit
instruction (§21/§22); Inventory has no reservation semantics today (ADR-028 confirms) and inventing one as a
side effect of Order's own spike would be exactly the scope creep CLAUDE.md §12 rules out.

**Inventory decrease inside the same transaction as `CONFIRMED`, vs. as a follow-up call** — not decided here
(implementation detail for F23); this ADR only fixes *that* the decrease happens at `CONFIRMED` and *how*
(reusing `createMovement`/`ADJUSTMENT_OUT` unchanged), not the exact transactional wiring, which F23 should
follow ADR-028's own already-proven one-transaction pattern for.

## Consequences
- (+) F23 can implement Order confirmation/cancellation against Inventory with **zero** changes to
  `src/db/schema/inventory.ts`, `src/modules/inventory/*` — reuses `createMovement` exactly as F22 shipped it.
- (+) The `INSUFFICIENT_STOCK` guarantee (ADR-028, including its concurrency proof) applies to Order
  confirmation automatically, for free — confirming two Orders that together exceed stock behaves exactly like
  the existing proven "exactly one concurrent decrease succeeds" guarantee, no new concurrency work needed.
- (−) Traceability from a `StockMovement` back to the `Order` that caused it is a free-text string, not a
  foreign key — a genuine limitation, explicitly named, not hidden. A report like "show me every stock movement
  caused by Order #123" is not efficiently queryable in F23's first cut.
- (−) No reservation/hold semantics — two draft Orders can both plan to sell the last unit of something; only
  one confirmation wins, the other gets `INSUFFICIENT_STOCK` at confirm time, not earlier. This is an accepted,
  named limitation, not silently ignored.

## Future extension path
A dedicated `StockMovement.type = "SALE"` (or `"ORDER_FULFILLMENT"`) value plus an optional
`stock_movements.order_id` (nullable, composite-FK to `orders`) is the natural, additive upgrade the moment
order-traceability through Inventory is a real requirement — it does not require touching this ADR's lifecycle
decisions, only `InventoryBalance`/`StockMovement`'s own schema (F22's domain), by F22's own established
pattern (ADR-021's composite-FK style). A reservation/hold system, if ever required, is its own ADR, layered on
top of `DRAFT`, not a redesign of `CONFIRMED`'s behavior here.
