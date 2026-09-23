# ADR-029 — Money Representation

- **Estado:** Accepted — implemented (F23), validated against real PostgreSQL
- **Data:** 2026-09-23
- **Phase:** F23A (spike, closes part of OD-01)

## Context
F23 needs `Product.price`, `OrderItem.unitPrice`, `OrderItem.lineSubtotal`, `Order.subtotal`, `Order.total`.
F18's `domain-model.md` PD-4 already recommended a representation (**"inteiro em unidades menores da moeda
(`price_minor bigint`) ... nunca float/double"**) at the conceptual stage, before any real money-shaped column
existed anywhere in this codebase. Since then, F22 built, tested, and shipped a different-but-related pattern
for exactly the same class of problem (precise decimal quantities): `numeric(20,6)` Postgres columns + a Zod
layer that accepts a JSON number or decimal string and always normalizes to a fixed-decimal string before the
value reaches Postgres (`src/modules/inventory/schemas.ts`), mirroring `ul-platform`'s own
`usage_events.quantity numeric(20,6)` convention. F23A's job (brief §4) is to evaluate money representation
explicitly, not adopt PD-4's proposal by default.

**This ADR revisits, and deliberately departs from, F18 PD-4's specific representation choice** — not silently:
the reasoning is below, in full, per the brief's own §0 instruction ("Do not silently override prior
architectural decisions").

## Decision

**Database:** `numeric(14,2)` for every money column (`products.price`, `order_items.unit_price`,
`order_items.line_subtotal`, `orders.subtotal`, `orders.total`). Never `float`/`double precision`, never a
bare `integer`/`bigint` minor-units column.

**API:** a decimal **string**, e.g. `"price": "10000.00"` — never a raw JSON number for money, for the exact
reason `quantity` is already a string on the wire (ADR-027): a JSON number is an IEEE-754 double, and
round-tripping a precise value through one reintroduces the imprecision `numeric` exists to avoid.

**Internal calculation:** the multiplication (`unitPrice × quantity`) and the rounding it requires happen in
**Postgres, via SQL**, never in JavaScript/TypeScript arithmetic. `numeric` is Postgres's own arbitrary-precision
base-10 decimal type — `numeric × numeric` is an exact operation, no binary floating point involved at any
step. Concretely: `ROUND(unit_price::numeric * quantity::numeric, 2)`. This needs no new decimal-math
dependency (no `decimal.js`/`big.js`) and extends the exact pattern `src/modules/inventory/repository.ts`
already uses for balance mutation (`quantity + $delta` evaluated in SQL, not in JS).

**Validation strategy:** Zod at the API boundary accepts a JSON number or a decimal string for `price` (same
duality `quantity` already has), rejects non-finite/negative values, and normalizes to a fixed 2-decimal string
before it reaches the repository layer — the same `quantitySchema` shape from `inventory/schemas.ts`, adapted
to 2 decimal places instead of 6.

**Rounding rule (validated empirically against the real `na-pista` Postgres instance, not assumed):**
Postgres's native `ROUND(numeric, n)` uses **round-half-away-from-zero** (the standard commercial/retail
rounding convention):

```sql
select round(0.125::numeric, 2);   -- 0.13  (not 0.12 — confirms away-from-zero, not banker's rounding)
select round(-0.125::numeric, 2);  -- -0.13 (away from zero in both directions)
select round(2.00::numeric(14,2) * 0.0625::numeric(20,6), 2);  -- 0.13
```
No custom rounding logic needs writing — the database's own built-in function already implements the desired
rule. Rounding happens **exactly once**, at the point a line subtotal is computed (`unitPrice × quantity →
ROUND(., 2) → lineSubtotal`); `Order.subtotal`/`Order.total` are then the plain sum of already-rounded line
subtotals — never re-rounded, never recomputed from an averaged price. This is deterministic: the same inputs
always produce the same stored outputs, and past totals never silently change if the rounding rule's
*implementation* were ever revisited (they're stored, not recomputed on read).

**Precision:** `numeric(14,2)` — 12 integer digits, 2 decimal places. 2 decimal places matches AOA's ISO 4217
minor-unit exponent (the confirmed initial currency — see ADR-030) and is the number every one of the brief's
own worked examples uses ("10,000 Kz", "12,000 Kz"). 12 integer digits is deliberately generous headroom (a
single line item over 999,999,999,999.99 Kz is not a real scenario for this business) without inventing a
business-driven cap that has no requirement behind it.

## Alternatives

**Integer minor units (`price_minor bigint`) — F18 PD-4's original proposal, rejected for F23A.**
Reasoning:
- `numeric(14,2)` and integer-cents are **mathematically equivalent** in what they can exactly represent — a
  fixed-scale Postgres `numeric` column stores the same information as an integer count of the smallest unit,
  with no precision disadvantage either way (both are exact, neither is a binary float).
- Minor units would require an ISO 4217 minor-unit-exponent lookup (how many minor units make one major unit,
  per currency) even in the trivial *single-currency* case this phase decides on (ADR-030) — one more piece of
  machinery for zero benefit today, since that lookup is unused until real multi-currency support exists, which
  is explicitly out of scope (brief §3/§16).
- It would introduce a **second, different** money-representation strategy alongside the just-proven, just-shipped
  `numeric` + decimal-string pattern F22 already established for the closely related "precise quantity" problem
  — inconsistent with no compensating benefit, and it duplicates a major↔minor conversion layer at every API
  boundary and UI display point that a `numeric` column simply doesn't need.
- The often-cited advantage of minor units — easy interop with payment gateways that themselves use integer
  cents (e.g., Stripe) — does not apply here: F23 explicitly excludes Payments (brief §3); that integration
  point, if it ever exists, belongs to Micha Express (CLAUDE.md §4), which would do its own conversion at its
  own boundary regardless of how Na Pista stores its own prices internally.

This is a reasoned revision of PD-4's *specific mechanism*, not of its *underlying intent* ("never float,
precise, deterministic") — PD-4's intent is fully honored; only the concrete column type changes, and only
because better evidence (a working, tested precedent) now exists that didn't when PD-4 was written.

**Floating point (`double precision`/JS `number` as the source of truth)** — rejected outright, as both F18 and
the brief itself already mandate (§4: "Do NOT use floating-point numbers for persistent monetary values").

**A decimal library in application code (`decimal.js`, `big.js`) for the multiplication** — considered and
rejected: it would duplicate arithmetic Postgres already performs exactly, add a new dependency, and create two
places (SQL and JS) that must agree on rounding behavior instead of one.

## Consequences
- (+) Zero new dependencies; extends a pattern already shipped, tested, and understood (ADR-027/028).
- (+) Rounding behavior is validated against the real database this project actually runs on, not assumed from
  documentation.
- (+) `Product.price`, `OrderItem.unitPrice`/`lineSubtotal`, `Order.subtotal`/`total` are all the same column
  type family — one mental model, one validation helper shape, one API convention.
- (−) A future currency with a different ISO 4217 minor-unit exponent (e.g., 0 decimals for JPY, 3 for KWD)
  would need either a currency-aware scale (a real future migration) or an explicit convention for how it's
  represented in a fixed `numeric(14,2)` column — deferred, not solved now, exactly as the brief instructs
  (§16); this is symmetric with what minor-units would also have needed at that point, so it is not a reason to
  have chosen the alternative.

## Future extension path
If/when a second currency with a different decimal-place convention is genuinely required, revisit this ADR
with a currency-aware scale strategy at that time — do not pre-build it now.
