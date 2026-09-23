# F23A — Commerce & Money Architecture Decisions

> **Decision spike. No Orders/OrderItems/pricing code is implemented in this phase.** Every decision below is
> evidence-based (prior reports/ADRs, real code inspection, or a real query against the actual `na-pista`
> Postgres instance) and closes exactly what F23 needs — nothing more. Full reasoning/alternatives live in
> [ADR-029](adr/ADR-029-money-representation.md)..[ADR-032](adr/ADR-032-order-inventory-boundary.md); this
> document is the consolidated, implementation-facing summary plus the F23 contract.

## 1. Executive summary

F23 needs `Product.price`, `Order`, `OrderItem`, and order totals. F18 left the money/currency model open
(OD-01) and F20/F22 deliberately built Products and Inventory with **no** money concept at all, exactly as
instructed. This phase closes the decisions required to implement Commerce without inventing financial
semantics mid-coding:

- **Money** is `numeric(14,2)` in Postgres, a decimal **string** on the wire, rounded exactly once via
  Postgres's own `ROUND()` (confirmed empirically: round-half-away-from-zero) — extending, not duplicating,
  the `numeric` + decimal-string pattern F22 already shipped for quantities.
- **Currency** is one per Organization (AOA, confirmed from the brief's own business context), never stored on
  `Product`, always **snapshotted** on `Order` at creation time.
- **Product.price** is a single, nullable, mutable current value — no history engine, no price lists. `NULL`
  (unset) and `0` (free) are distinct, both valid.
- **`OrderItem`** snapshots `unitPrice` (and `productName`) at the moment it's created — never reads the live
  `Product.price` again.
- **Quantity** on `OrderItem` reuses Inventory's own `numeric(20,6)` — deliberately, because a future
  `StockMovement` will consume this exact value.
- **Order lifecycle**: `DRAFT → CONFIRMED → COMPLETED`, `CANCELED` from either `DRAFT` or `CONFIRMED`. Inventory
  decreases **only** at `CONFIRMED` (existing `ADJUSTMENT_OUT`, zero Inventory schema changes), reversed on
  cancellation from `CONFIRMED` via the existing `ADJUSTMENT_IN`.
- **`Order.customerId` is nullable** — closes OD-03, confirming F18's own recommendation (walk-in/anonymous
  sales are real).

This document, together with ADR-029..032, is the package F23 implements directly from — see §18 "F23
implementation contract."

## 2. Decisions (index)

| # | Question | Decision | Where |
|---|---|---|---|
| 1 | Where is selling price stored? | `Product.price`, nullable | §5, ADR-031 |
| 2 | How is money represented? | `numeric(14,2)`, never float | §3, ADR-029 |
| 3 | Currency model? | One per Organization, snapshotted on Order | §4, ADR-030 |
| 4 | Rounding? | Postgres `ROUND(.., 2)`, half-away-from-zero, once | §8, ADR-029 |
| 5 | OrderItem price history? | Snapshot `unitPrice` + `productName` at creation | §6, ADR-031 |
| 6 | Totals? | `subtotal = Σ line subtotals`; `total = subtotal` (no tax/discount yet) | §7 |
| 7 | Can Product price change? | Yes — current state only; Orders unaffected (snapshot) | §5, §15 |
| 8 | Can an Order change after creation? | Items only in `DRAFT`; frozen from `CONFIRMED` on | §11 |
| 9 | Quantity × unit price semantics? | Exact SQL decimal multiply, rounded once | §7, §8 |
| 10 | Postgres/TypeScript representation? | `numeric(14,2)` DB, decimal string API/TS | §3 |
| 11 | Minimum viable commerce model? | §18 (the contract) | §18 |

## 3. Money representation

**Database:** `numeric(14,2)` for every money column. **API:** decimal string, e.g. `"price": "10000.00"`.
**Internal calculation:** the multiplication and its rounding happen in Postgres SQL
(`ROUND(unit_price * quantity, 2)`), never in JS — `numeric` arithmetic is exact, no binary float at any step.
**Validation:** a Zod schema shaped exactly like `inventory/schemas.ts`'s `quantitySchema` (accepts number or
string, rejects non-finite/negative, normalizes to a fixed 2-decimal string before it reaches the repository).

This deliberately **departs from** F18's `domain-model.md` PD-4 proposal (`price_minor bigint`) — stated
explicitly, not silently, with full reasoning in ADR-029: `numeric(14,2)` is exactly as precise as integer
minor units for a fixed-scale currency, needs no ISO-4217 minor-unit lookup table for the single-currency v1
scope, and reuses a pattern already proven end-to-end (ADR-027/028) instead of introducing a second one.

Empirical validation against the real `na-pista` database (not assumed):
```sql
select round(0.125::numeric, 2);                                  -- 0.13
select round(-0.125::numeric, 2);                                 -- -0.13
select round(2.00::numeric(14,2) * 0.0625::numeric(20,6), 2);     -- 0.13
```
Confirms Postgres's native `ROUND(numeric, n)` is round-half-away-from-zero — the standard commercial
convention — with no custom rounding code to write.

## 4. Currency model

One currency per Organization (`currencyCode`, ISO 4217, e.g. `"AOA"` — the confirmed initial and only
currency, inferred from the brief's own worked examples and Última Linha's Angolan market, already reflected
in F21's customer-phone validation). **Not** stored on `Product` (would allow disagreeing with the
Organization's own currency — an explicitly bad state per the brief §13). **Stored as an explicit snapshot on
`Order`** (`Order.currency`), copied at creation time — historical Orders must not silently reinterpret their
stored amounts if the Organization's configured currency ever changes later (brief §14's own steer, adopted).
One currency per Order; every `OrderItem` is implicitly in that currency — no per-item currency field, no
multi-currency Order. No conversion, no exchange rates, anywhere in this phase or in F23.

`TenantSettings` does not exist as a real table yet (confirmed: not in `src/db/schema/`) — where exactly
`currencyCode` lives (a new `tenant_settings` table vs. a Na-Pista-owned extension column) is an **F23
implementation detail**, not re-decided here; either satisfies this ADR.

## 5. Product price model

`Product.price` — `numeric(14,2)`, **nullable**, single current mutable value. No price-history table, no
price lists, no effective-dating — none demonstrated as required (brief §6). Nullable because every existing
F20/F21/F22 Product has no price today (migration compatibility) and because "not yet priced" is a real,
distinct state from "priced at zero." `CHECK (price IS NULL OR price >= 0)` — negative is never valid; zero is
explicitly valid (promotional/complimentary/sample, brief §11). Enforcement that a Product **must** have a
price moves to the point that actually needs it — adding it to an Order — not to Product creation/update.

## 6. OrderItem price snapshot

Mandatory, per the brief's own worked example (§7). `OrderItem.unitPrice` (`numeric(14,2)`, `NOT NULL`) is
copied from `Product.price` when the item is created and never re-read from `Product` afterward — there is no
live reference for a later `Product.price` change to follow. `OrderItem.productName` (`text`, `NOT NULL`) is
snapshotted alongside it, for the same reason, extended by this phase to the one other Product attribute a
historical Order actually displays (flagged in ADR-031 as F23A's own extrapolation, not a literal brief line
item — F23 may revisit with the business if it disagrees, but the cost of including it now is one extra
column).

## 7. Quantity/price arithmetic

`OrderItem.quantity` reuses Inventory's own representation: `numeric(20,6)`, same normalize-to-string Zod
pattern. Not assumed — decided explicitly because a future `StockMovement` created at Order confirmation
(ADR-032) consumes this exact value; using a different precision for Order quantity than Inventory quantity
would force a lossy conversion exactly at that boundary. Line subtotal: `ROUND(unitPrice × quantity, 2)`,
computed once in SQL, stored (not recomputed on every read) — see §8 for the full worked structure. Order
totals are sums of already-rounded, already-stored line subtotals.

## 8. Rounding

Exactly the structure the brief itself lays out (§9), now with a concrete mechanism:
```
unitPrice (numeric(14,2)) × quantity (numeric(20,6))
  → exact Postgres numeric multiplication (no float anywhere)
  → ROUND(., 2)   -- round-half-away-from-zero, confirmed empirically (§3)
  → OrderItem.lineSubtotal (numeric(14,2), stored)

Order.subtotal = SUM(lineSubtotal over all OrderItems)   -- sum of already-rounded values, never re-rounded
Order.total    = Order.subtotal                          -- no tax/discount/shipping in F23 (§10/§18)
```
Rounding occurs **once**, at the line-item boundary. Illustrative tie case (clean numbers, not realistic
prices, chosen to land exactly on the 2-decimal rounding boundary): `unitPrice = 2.00`, `quantity = 0.0625` →
exact product `0.125000` → `ROUND(., 2)` → `0.13` (half-away-from-zero, not `0.12`, which round-half-even would
give). Deterministic: identical inputs always produce identical stored outputs, and a later revisit of the
rounding *implementation* never silently changes a past Order's stored total (totals are stored, not derived
on read).

## 9. Product price validation

`price >= 0` (`CHECK`, `NULL` allowed). Zero is explicitly valid, distinct from `NULL`/missing (§5). No
business-driven maximum beyond `numeric(14,2)`'s own ceiling — none justified by any requirement.

## 10. Customer requirement

`Order.customerId` — **nullable**. Closes OD-03, confirming F18's own PD-8 recommendation: walk-in/anonymous
sales are a real, common flow (a boutique or yogurt seller does not require every buyer to be a registered
`Customer`). No change to `Customer` itself in this phase (brief §20's explicit instruction).

## 11. Order lifecycle

`DRAFT → CONFIRMED → COMPLETED` (terminal); `CANCELED` reachable from `DRAFT` or `CONFIRMED` (terminal). Items
mutable only in `DRAFT`; frozen from `CONFIRMED` onward (once real stock has moved, the Order's contents must
stop changing — matches the snapshot semantics already decided in §6). No `CONFIRMED → DRAFT`. Full transition
table and reasoning: ADR-032.

## 12. Inventory interaction

Inventory changes **only** at `DRAFT → CONFIRMED` (existing `ADJUSTMENT_OUT` via the existing `createMovement`
service, zero Inventory schema changes) and is reversed at `CONFIRMED → CANCELED` (existing `ADJUSTMENT_IN`).
`COMPLETED` has no Inventory effect (the decrease already happened). No reservation/hold system — `DRAFT`
Orders never touch Inventory at all; two drafts can both plan to sell the last unit, only one confirmation
succeeds (the existing `INSUFFICIENT_STOCK` guarantee, including its proven concurrency behavior, applies for
free). Traceability from a `StockMovement` to its Order is via the existing free-text `reason` field for F23's
first cut — not a foreign key yet; named limitation, not an oversight (ADR-032).

## 13. Tenant isolation

`Order`/`OrderItem` are tenant-scoped exactly like every prior module (`organization_id NOT NULL` on both).
Composite FKs, same pattern ADR-021/027 already proved: `OrderItem.(organization_id, product_id) →
products(organization_id, id)`, `OrderItem.(organization_id, order_id) → orders(organization_id, id)`,
`Order.(organization_id, customer_id) → customers(organization_id, id)` (nullable — NULL rows are exempt from
the FK check, same as `products.category_id` today).

## 14. API money representation

Decimal string, never a bare JSON number, matching the existing `quantity` convention exactly:
```json
{ "price": "10000.00", "currency": "AOA" }
```
```
POST /v1/organizations/{orgId}/orders/{orderId}/items
{ "productId": "...", "quantity": "1.000000" }

201
{ "data": { "id": "...", "productId": "...", "productName": "Camisola Azul",
            "unitPrice": "10000.00", "quantity": "1.000000",
            "lineSubtotal": "10000.00", "createdAt": "..." } }
```
`currency` is an ISO 4217 uppercase 3-letter code string.

## 15. Database constraints

- `products.price numeric(14,2) NULL`, `CHECK (price IS NULL OR price >= 0)`.
- `orders.currency text NOT NULL`, shape-validated (e.g. `CHECK (currency ~ '^[A-Z]{3}$')`) — the *specific*
  allowed currency (`AOA` only, for now) is an application/config concern, not hardcoded into a DB `CHECK` that
  would need a migration every time a currency is added.
- `orders.subtotal numeric(14,2) NOT NULL`, `orders.total numeric(14,2) NOT NULL`, both `CHECK (>= 0)` —
  server-computed, never client-supplied.
- `order_items.unit_price numeric(14,2) NOT NULL`, `CHECK (unit_price >= 0)`.
- `order_items.quantity numeric(20,6) NOT NULL`, `CHECK (quantity > 0)` — matches `stock_movements.quantity`'s
  own constraint style (ADR-028).
- `order_items.line_subtotal numeric(14,2) NOT NULL`, `CHECK (line_subtotal >= 0)` — server-computed, stored.

Do not over-constrain beyond what's justified above (brief §18) — no additional business-rule caps invented.

## 16. Alternatives rejected

Full reasoning in each ADR; summary:
- **Integer minor units (`price_minor bigint`)** — F18's original proposal; rejected in favor of `numeric(14,2)`
  (ADR-029) — mathematically equivalent precision, avoids a second money-representation strategy and an unused
  minor-unit lookup table.
- **`Product.currency` / multi-currency Product or Order** — rejected; no requirement, creates a disagreement
  state the brief explicitly warns against (ADR-030).
- **Order-level price-list/history engine** — rejected; no demonstrated requirement (ADR-031).
- **Product price required (`NOT NULL`)** — rejected; breaks existing Products, forces a fake default
  (ADR-031).
- **Decrease Inventory at `COMPLETED` instead of `CONFIRMED`** — rejected; `CONFIRMED` is the real commitment
  point (ADR-032).
- **A dedicated `SALE` StockMovement type + `orderId` FK now** — the eventually-correct answer, deliberately
  deferred because it requires modifying the Inventory model, which the brief instructs against for this phase
  (ADR-032).
- **A reservation/hold system for `DRAFT` Orders** — explicitly out of scope (brief §21/§22).
- **A decimal-math library in application code** — rejected; Postgres's own `numeric` arithmetic is exact and
  already proven; a second arithmetic engine would only risk disagreement (ADR-029).

## 17. Deferred decisions

- **Exact home for `currencyCode`** (`TenantSettings` table vs. an extension column elsewhere) — F23
  implementation detail, not architectural; either satisfies ADR-030.
- **Multi-currency Organizations, currency conversion, exchange rates** — distinct future module.
- **Price history / price lists / effective-dated pricing** — additive, the moment a real requirement appears.
- **Dedicated `SALE` StockMovement type + `Order` FK for first-class traceability** — the correct long-term
  fix for ADR-032's named limitation; deferred to whenever an Inventory schema change is next justified.
- **Order reservation/hold semantics** — a distinct future feature, not part of F23's minimum lifecycle.
- **Tax, discounts, shipping, fees** — `Order.total = Order.subtotal` only, in F23; any of these is a future,
  additive extension (separate component fields/tables), never speculative fields added now (brief §10).
- **OD-01's full original scope** ("moedas/países suportados [plural], casas decimais por moeda [plural]") is
  only *partially* closed here — closed for the single-currency (AOA) v1 scope F23 actually needs; the general,
  multi-country question remains open until a real second currency is required.

## 18. F23 implementation contract

**Product** (extends the existing table, ADR-031):
- `price numeric(14,2) NULL`, `CHECK (price IS NULL OR price >= 0)`.

**Order** (new table, ADR-030/031/032, tenant-scoped like every prior module):
- `id uuid PK`, `organizationId uuid NOT NULL`, `customerId uuid NULL` (composite FK to `customers`, nullable),
  `status text NOT NULL` (`DRAFT|CONFIRMED|COMPLETED|CANCELED`), `currency text NOT NULL` (snapshot),
  `subtotal numeric(14,2) NOT NULL DEFAULT 0`, `total numeric(14,2) NOT NULL DEFAULT 0`, `createdAt`,
  `updatedAt`.

**OrderItem** (new table, ADR-031/032, tenant-scoped):
- `id uuid PK`, `organizationId uuid NOT NULL`, `orderId uuid NOT NULL` (composite FK to `orders`),
  `productId uuid NOT NULL` (composite FK to `products`), `productName text NOT NULL` (snapshot),
  `unitPrice numeric(14,2) NOT NULL` (snapshot, `CHECK >= 0`), `quantity numeric(20,6) NOT NULL`
  (`CHECK > 0`), `lineSubtotal numeric(14,2) NOT NULL` (`CHECK >= 0`, server-computed), `createdAt`.

**Customer relationship:** optional (`Order.customerId` nullable) — anonymous/walk-in sales are valid.

**Currency:** comes from the Organization's single configured `currencyCode` (exact storage location is an F23
implementation detail); snapshotted onto `Order.currency` at creation, never re-derived afterward.

**Money:** `numeric(14,2)` in Postgres; decimal string (`"10000.00"`) in the API; multiplication + rounding
performed in SQL via `ROUND(numeric * numeric, 2)`, never in application-code float/JS arithmetic.

**Totals:** `lineSubtotal = ROUND(unitPrice × quantity, 2)` per item (rounded once, stored);
`subtotal = SUM(lineSubtotal)`; `total = subtotal` (no tax/discount/shipping fields in F23).

**Rounding:** round-half-away-from-zero, Postgres's native `ROUND(numeric, 2)` — confirmed empirically, no
custom implementation needed.

**Lifecycle:** `DRAFT → CONFIRMED → COMPLETED` (terminal); `CANCELED` from `DRAFT` or `CONFIRMED` (terminal).
Items mutable only in `DRAFT`.

**Inventory:** F23 calls the existing `createMovement` service — `ADJUSTMENT_OUT` per `OrderItem` at
`DRAFT → CONFIRMED`; `ADJUSTMENT_IN` per `OrderItem` at `CONFIRMED → CANCELED`. **No Inventory schema change.**
`reason` field carries `"Order {orderId} confirmed/canceled"` for now.

**Tenant isolation:** `organization_id NOT NULL` on `Order`/`OrderItem`; composite FKs
`(organization_id, order_id) → orders`, `(organization_id, product_id) → products`,
`(organization_id, customer_id) → customers` (nullable); repository requires a resolved `TenantContext`, same
pattern as every module since ADR-021.

F23 does not need to make any further monetary or currency decision to begin implementation.

## 19. Design system

All future Commerce UI inherits the existing Na Pista Default UI design system verbatim —
[`na-pista-console/DESIGN.md`](../../na-pista-console/DESIGN.md), already established (dark
black/charcoal foundation, warm off-white typography, restrained champagne/gold accent reserved for
primary actions, semantic success/warning/error colors kept distinct from gold). **Not** Última Linha's own
landing-page identity (CLAUDE.md's own UL vs. product-brand distinction, restated for Commerce specifically per
this brief's §24). No new visual language is introduced by this phase — there is no UI in this phase.
