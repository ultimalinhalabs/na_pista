# F23A Report — Commerce & Money Architecture Spike

## Status

**COMPLETE.** F23A is a decision spike; its Definition of Done is a coherent, evidence-based decision package —
not running code. Every question the brief asked (§0–§21) is answered with either a citation to prior
work/code actually inspected, or a real query run against the actual `na-pista` Postgres instance. Nothing was
silently overridden: where this phase departs from F18's `domain-model.md` PD-4 (integer minor units), the
departure is explicit, reasoned, and documented (ADR-029). No Order/OrderItem/pricing production code exists
after this phase — confirmed by `git status`/`git diff` below.

## Decisions

See [`docs/f23a-commerce-money-decisions.md`](f23a-commerce-money-decisions.md) for the full package. Summary:
money = `numeric(14,2)` + decimal-string API (not F18's proposed minor-units bigint — reasoned deviation);
currency = one per Organization, snapshotted on Order, never on Product; Product.price = single nullable
current value, no history engine; OrderItem snapshots `unitPrice` + `productName`; OrderItem.quantity reuses
Inventory's `numeric(20,6)`; rounding = Postgres's native `ROUND(numeric, 2)` (round-half-away-from-zero,
confirmed empirically), applied once per line item; totals = sum of already-rounded line subtotals, no
tax/discount/shipping fields yet; Order lifecycle = `DRAFT → CONFIRMED → COMPLETED`/`CANCELED`; Inventory
changes only at `CONFIRMED` (existing `ADJUSTMENT_OUT`/`ADJUSTMENT_IN`, zero Inventory schema change);
`Order.customerId` nullable (closes OD-03).

## Rejected alternatives

Full reasoning per decision lives in each ADR's own "Alternatives" section. Highest-signal ones:
1. **Integer minor units (`price_minor bigint`)** — F18's own original PD-4 proposal — rejected in favor of
   `numeric(14,2)`, explicitly and with reasoning (ADR-029), not silently.
2. **Currency on `Product`** — rejected (creates a possible-disagreement state with Organization currency).
3. **Price-history/price-list engine now** — rejected (no demonstrated requirement).
4. **`Product.price` required** — rejected (breaks every existing F20/F21/F22 Product; no honest default).
5. **A dedicated `SALE` StockMovement type + `orderId` FK now** — the eventually-correct design, deliberately
   deferred because the brief instructs this phase not to modify the Inventory model.
6. **A reservation/hold system for draft Orders** — explicitly out of scope per the brief.
7. **A decimal-math library in application code** — rejected; Postgres's own `numeric` arithmetic already does
   this exactly, with no new dependency.

## ADRs produced

- [ADR-029 — Money Representation](adr/ADR-029-money-representation.md)
- [ADR-030 — Currency Model](adr/ADR-030-currency-model.md)
- [ADR-031 — Product Pricing and Order Price Snapshot](adr/ADR-031-product-pricing-and-order-price-snapshot.md)
- [ADR-032 — Order Lifecycle and the Order/Inventory Boundary](adr/ADR-032-order-inventory-boundary.md)

Four ADRs — one per genuinely distinct architectural decision the brief asked for (§25's own suggested list),
not padded to increase document count.

## Validation performed

- Read `f18-review.md` (OD-01/OD-03 and every other still-open decision), `domain-model.md` (PD-4/PD-6/PD-8,
  the ERD, and §6 invariants), `tenancy.md` (`TenantSettings` conceptual shape), `f19-report.md`, `f20-report.md`
  (confirmed Product shipped with no price, citing OD-01), `f21-report.md`, `f22-report.md` (already in this
  session's own context — re-confirmed rather than re-read verbatim), ADR-018/020/021/027/028, `api-boundary.md`
  (envelope/idempotency conventions — confirmed Orders/inventory-movements are already named as
  `Idempotency-Key` candidates in the existing convention table, unchanged by this phase).
- Inspected the real, current `Product` schema (`src/db/schema/products.ts`) — confirmed no `price` column
  exists today, confirming F20/ADR-018's own claim first-hand rather than trusting the report alone.
- Inspected `src/db/schema/` in full — confirmed `TenantSettings` does not exist as a real table anywhere.
- Inspected `ul-platform`'s own schema (`grep -rl "price\|amount\|money\|currency" src/db/schema/`) — confirmed
  zero results: there is no Platform precedent for money to reuse or diverge from; this is entirely Na Pista's
  own domain, consistent with CLAUDE.md §2/§3.
- Inspected `ul-platform/src/db/schema/usage.ts` — confirmed `usage_events.quantity numeric(20,6)` is the exact
  precedent already cited for Inventory's own quantity choice (ADR-027), reinforcing the money-representation
  reasoning in ADR-029.
- **Ran a real, isolated, read-only query against the actual `na-pista` Postgres database** (a temporary script,
  never committed, deleted immediately after use — no production schema touched) to confirm Postgres's `ROUND`
  rounding mode empirically rather than assume it:
  ```
  round(0.125, 2)  = 0.13
  round(0.135, 2)  = 0.14
  round(2.5, 0)    = 3
  round(3.5, 0)    = 4
  round(-0.125, 2) = -0.13
  round(2.00 * 0.0625, 2) = 0.13
  ```
  Confirms round-half-away-from-zero — the rounding rule ADR-029/the decisions doc now states as validated,
  not assumed.

## Unresolved questions

Named explicitly, per the brief's own instruction (§26: "document as unresolved rather than inventing one"):
1. **Exact storage location for `currencyCode`** — a new `TenantSettings` table vs. an extension column
   elsewhere. Deliberately left as an F23 implementation detail (either satisfies ADR-030); deciding the exact
   table shape without a concrete F23 schema-design pass in front of it would be premature.
2. **Full OD-01 scope** ("moedas/países suportados" plural) remains open beyond the single-currency (AOA) v1
   this phase actually needs — intentionally not force-closed.
3. **Order idempotency mechanics** — `api-boundary.md` already names Orders as an `Idempotency-Key` candidate;
   this phase did not re-derive that decision (it predates F23A and is not money-specific), but F23 should
   apply it exactly as documented there, unchanged.

## F23 implementation contract

See [`docs/f23a-commerce-money-decisions.md`](f23a-commerce-money-decisions.md) §18 — reproduced there in full
(Product/Order/OrderItem fields, currency source/snapshot point, money DB/API representation, totals formula,
rounding rule, lifecycle states/transitions, exact Inventory interaction point, tenant-isolation constraints).
Not duplicated here to avoid the two documents drifting apart.

## Known limitations

1. **Order→StockMovement traceability is a free-text string, not a foreign key**, in F23's first cut (ADR-032)
   — a named, deliberate limitation (avoids an Inventory schema change this phase is told not to make), not an
   oversight. The extension path (a `SALE` movement type + `orderId` column) is documented.
2. **No reservation/hold system** — two `DRAFT` Orders can both plan to consume the last unit of a product;
   only the first `CONFIRMED` wins (the existing, proven `INSUFFICIENT_STOCK` guarantee applies automatically).
   Explicitly out of scope for this phase, not silently ignored.
3. **`TenantSettings` still does not exist** — this phase decided the currency *model*, not the currency
   *table*; F23 must still stand up wherever `currencyCode` actually lives.
4. **Only AOA is designed for** — the broader "which currencies/countries" question (OD-01's full original
   scope) stays open; multi-currency Organizations and conversion are explicitly a distinct future module.
5. **No tax/discount/shipping/fee model** — `Order.total = Order.subtotal` only; any of these is a future,
   additive extension, not speculatively scaffolded now (matches the brief's own §10 instruction).

## Self review (brief §30)

1. **Can Product have a valid selling price?** Yes — `price numeric(14,2)`, settable any time after creation
   (ADR-031).
2. **Can Product price be changed safely?** Yes — it's current state only; changing it never touches any
   existing `OrderItem` (no live reference from `OrderItem` back to `Product.price`, ADR-031 §"Decision").
3. **Can historical OrderItems preserve old prices?** Yes — `OrderItem.unitPrice` is copied in at creation and
   never re-read from `Product` afterward; worked Day-1/Day-2 example in ADR-031 mirrors the brief's own §7
   example exactly.
4. **Can money be represented without floating-point errors?** Yes — `numeric(14,2)` end to end (DB, API as a
   decimal string, calculation via Postgres's exact `numeric` arithmetic); confirmed no float/double anywhere
   in the decision (ADR-029).
5. **Is currency unambiguous?** Yes — one currency per Organization, never duplicated on Product, snapshotted
   once on Order; structurally impossible for an Order's items to disagree on currency (ADR-030).
6. **Can an Organization change its currency without changing historical Orders?** Yes — `Order.currency` is a
   creation-time snapshot, never re-derived from the live Organization setting (ADR-030).
7. **Can Orders contain multiple currencies?** No, by construction — no per-item currency field exists to
   disagree with `Order.currency` (ADR-030).
8. **Are rounding rules deterministic?** Yes — a single, named rule (Postgres `ROUND`, half-away-from-zero),
   applied at exactly one point (the line-item boundary), empirically confirmed against the real database, with
   a worked tie-case example (ADR-029, decisions doc §8).
9. **Is quantity × price deterministic?** Yes — exact Postgres `numeric` multiplication, no JS float step,
   rounded once, stored (not recomputed on read) (ADR-029/decisions doc §7-8).
10. **Is zero-price behavior explicit?** Yes — `price = 0` is explicitly valid (promotional/free), distinct
    from `price = NULL` (ADR-031).
11. **Is missing-price behavior explicit?** Yes — `NULL` means "not yet priced," enforced as "cannot be added
    to an Order" at Order-item-creation time, not at Product creation (ADR-031).
12. **Is Customer requirement explicit?** Yes — `Order.customerId` nullable, closing OD-03 (decisions doc §10).
13. **Is Order lifecycle explicit enough for F23?** Yes — full state diagram, allowed transitions, and terminal
    states given (ADR-032).
14. **Is the Inventory interaction point explicit?** Yes — exactly `DRAFT → CONFIRMED` (decrease) and
    `CONFIRMED → CANCELED` (reversal), naming the exact existing movement types reused and confirming zero
    Inventory schema changes (ADR-032).
15. **Are money and inventory valuation kept separate?** Yes — explicitly restated in ADR-032's "Decision":
    no `inventory.cost`/`inventory.value` introduced anywhere in this phase.
16. **Is tenant isolation defined for Order and OrderItem?** Yes — composite-FK shape given for both,
    reusing the exact pattern ADR-021/027 already proved (decisions doc §13/§18).
17. **Can F23 now implement Orders without making new monetary decisions?** Yes — §18's contract gives every
    field, type, constraint, snapshot point, rounding rule, lifecycle transition, and Inventory-interaction
    point F23 needs; nothing about money/currency/pricing/lifecycle/Inventory-boundary is left for F23 to
    reinterpret.

All 17 answered with evidence or explicit architectural reasoning — marking **COMPLETE**.

## Exact next step

**F23 — Order Management Vertical Slice**: implement `Product.price`, `Order`, `OrderItem` exactly per this
document's §18 contract, reusing `createMovement`/`ADJUSTMENT_OUT`/`ADJUSTMENT_IN` unchanged for the Inventory
boundary (ADR-032), reusing the tenant-scoped-repository/entitlement-gate/audit/usage pattern proven four times
already (Categories, Products, Customers, Inventory). The one implementation-detail decision F23 must still
make going in (not an architectural one, per "Unresolved questions" above) is exactly where `currencyCode`
lives — a `TenantSettings` table or an extension column — either is compatible with this package.
