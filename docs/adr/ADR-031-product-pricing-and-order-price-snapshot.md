# ADR-031 — Product Pricing and Order Price Snapshot

- **Estado:** Accepted — implemented (F23)
- **Data:** 2026-09-23
- **Phase:** F23A (spike)
- **Closes:** the "product price model" part of OD-01, for this slice's scope

## Context
ADR-018 (F20) deliberately shipped `Product` with **no** `price` column, citing OD-01 as still open and the
F20 brief's own instruction not to invent a financial model. F23A must now decide the actual shape, without
inventing what isn't demonstrated as required (brief §6: "prefer the minimum model required by the current
product definition... do NOT build a price-history engine unless there is a demonstrated requirement"), and
without silently breaking existing F20/F21/F22 Products, which today have no price at all.

## Decision

**Product has exactly one current, mutable price.** `Product.price` — `numeric(14,2)` (ADR-029),
**nullable**. No price-history table, no price lists, no effective-dating. Nothing in this phase's scope
demonstrates a need for any of those (no requirement asked for scheduled price changes, promotional windows, or
per-channel pricing) — building one now would be exactly the speculative abstraction CLAUDE.md §12/§14 rules
out. If a genuine requirement for price history appears later, it is an **additive** table
(`product_price_history`) that the current mutable `Product.price` column continues to represent "price right
now" for — not a redesign.

**`Product.price` is OPTIONAL (nullable), not required.**
- **Migration compatibility:** every Product created in F20/F21/F22 has no price today; adding a `NOT NULL`
  column would force inventing a fake value for every existing row. `NULL` is the only honest default — it
  means "no price has been set," not "price is zero."
- **`NULL` (no price) and `0` (free) are explicitly different, meaningful states**, per the brief's own
  instruction (§11/§12): a product can genuinely be free (promotional, complimentary, sample, service-linked) —
  `price = 0` is a valid, deliberate business state, not an error. A product that has simply never had a price
  configured yet is `price = NULL`, and is not yet sellable.
- **Enforcement moves to the point that actually needs it: Order creation.** Rather than forcing every Product
  to carry a price the moment it's created (which would block the exact "Product exists, pricing comes later"
  workflow F20 shipped without controversy), the rule is: **adding a Product to an Order requires that
  Product's current `price` to be non-null at that moment** — `400/409`-class validation at
  `POST .../orders/:id/items`, not a `Product` constraint. This is the minimum rule that actually protects the
  invariant that matters (an `OrderItem` can never exist without a real price to snapshot) without adding
  workflow steps nothing asked for.

**Price constraints:** `CHECK (price IS NULL OR price >= 0)`. Negative price is never valid — no business case
demonstrated (refunds/credits are explicitly out of scope, brief §3). No additional business-rule maximum
beyond `numeric(14,2)`'s own natural ceiling — no requirement justifies inventing one.

**`OrderItem` snapshots the price — mandatory, per the brief's own explicit example (§7).**
`OrderItem.unitPrice` (`numeric(14,2)`, `NOT NULL`) is copied from `Product.price` at the moment the item is
added to the Order and **never re-read from the Product afterward.** A later `Product.price` change never
touches any existing `OrderItem`:

```
Day 1: Product.price = 10,000 Kz  →  OrderItem.unitPrice = 10,000 Kz (copied in)
Day 2: Product.price changes to 12,000 Kz
       → the existing OrderItem still reads 10,000 Kz — unaffected, by construction
         (there is no live reference from OrderItem back to Product.price to follow)
```
`OrderItem → Product → current Product.price` is never a valid path for computing a historical total — the
brief calls this "mandatory to decide" (§7), and the invariant is already restated generally in
`domain-model.md` §6 ("Preço nunca é ponto flutuante; `OrderItem` nunca depende do preço actual do produto") —
this ADR closes it concretely for the real schema.

**`OrderItem` also snapshots the product's display name** (`OrderItem.productName`, `text NOT NULL`, copied
alongside `unitPrice`). This extends the same principle the brief mandates for price to the one other
Product attribute a historical Order actually displays: if a Product is later renamed or archived, a past
Order showing what was actually sold at the time is more correct — and cheaper to decide now, alongside the
price snapshot, than to retrofit later. This is F23A's own extrapolation of the brief's stated principle
(§7's heading is specifically about price), not something the brief explicitly asked for by name — flagged
as such so F23 does not mistake it for a literal brief requirement.

## Alternatives

**`Product.price` required (`NOT NULL`) from the start** — rejected: breaks every existing F20/F21/F22 Product
without a real value to migrate to; would force a fake default (the brief explicitly warns against inventing
"a fake price such as 0" for migration purposes, §12).

**A separate `PriceList`/multi-tier pricing model** — rejected: no requirement demonstrates per-customer,
per-channel, or per-quantity pricing tiers; `Product.price` as a single current value is the minimum viable
model (brief §6/§11's own framing).

**Enforcing "Product must have a price" as a `Product`-level state (e.g., a `status` value or a required field
at creation)** — rejected: conflates two different lifecycles (a Product existing vs. a Product being sellable
today); the existing `ACTIVE|ARCHIVED` status (ADR-020) already means something else and should not be
overloaded. Enforcing at Order-item-creation time is the minimum, correctly-scoped rule.

**Not snapshotting `productName`** — considered; rejected on the reasoning above, but flagged as the one point
in this ADR that goes slightly beyond the brief's literal ask, for F23 to accept or revisit with the business
if it disagrees.

## Consequences
- (+) No existing Product row needs a migration-time price invented.
- (+) Historical Order correctness is structurally guaranteed (no live FK-style dependency from `OrderItem`
  back to `Product.price`) — not just a convention future code must remember to honor.
- (+) `price = 0` (free/promotional) and `price = NULL` (not yet priced) both have clear, distinct, intentional
  meanings — neither is an accident or an edge case nobody thought about.
- (−) A Product without a price simply cannot be sold yet — a business must set a price before its first Order
  for that Product; this is a real, deliberate constraint, not a gap.

## Future extension path
Price history (`product_price_history`), price lists/tiers, and effective-dated pricing are all additive
tables layered on top of the current `Product.price` column, the moment a real requirement demonstrates the
need — none of them require touching `OrderItem`'s snapshot behavior, which is already correct regardless of
how Product pricing evolves.
