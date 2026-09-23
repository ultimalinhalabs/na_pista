# ADR-030 — Currency Model

- **Estado:** Accepted — implemented (F23)
- **Data:** 2026-09-23
- **Phase:** F23A (spike, closes OD-01 for Commerce's initial scope)
- **Closes:** OD-01 (currency/decimal-places part; the broader "which countries/currencies are ever supported"
  stays intentionally open beyond what F23 needs — see "Deferred" below)

## Context
F18 left OD-01 open: currency, locale, decimal places, multi-currency. `tenancy.md` had already sketched
`TenantSettings.currency_code` conceptually, but **`TenantSettings` does not exist as a real table anywhere in
this codebase** — confirmed by inspecting `src/db/schema/` (only `auditEvents`, `categories`, `customers`,
`index`, `inventory`, `products` exist). `ul-platform`'s own schema has no money/currency/price concept
anywhere either (confirmed: `grep -rl "price\|amount\|money\|currency" src/db/schema/` in `ul-platform` returns
nothing) — there is no Platform precedent to reuse; this is entirely Na Pista's own domain, as CLAUDE.md §2/§3
already establishes (UL Platform never holds product-specific business data).

## Decision

**One currency per Organization.** A new, minimal `TenantSettings` concept (or, if F23 prefers not to stand up
a full settings table yet, a single `organizations.na_pista_currency_code` — the exact column home is an F23
implementation detail, not re-decided here) holds `currencyCode` (ISO 4217, e.g. `"AOA"`), **NOT NULL** once
Commerce is enabled for that organization. Angola/Kwanza (`AOA`) is the confirmed initial and only currency
this phase designs for — inferred explicitly from the brief's own business context (§4 names "Angola/Kwanza"
directly; Última Linha's own established market, already reflected in F21's customer-phone validation being
Angolan-shaped-but-not-Angola-only). This is stated as an explicit basis, not silently assumed.

**Product does NOT store its own currency.** A product's price is denominated in whatever currency its
Organization operates in — implicit, not redundant. Storing `Product.currency` alongside
`TenantSettings.currencyCode` would create exactly the bad state the brief warns against (§13): "Organization
currency = AOA, Product currency = USD" — two values that can silently disagree. The simplest consistent model
wins, per CLAUDE.md §14 ("prioritize ... simplicity").

**Order stores an explicit currency snapshot.** `Order.currency` is copied from the Organization's
`currencyCode` **at order-creation time** and never re-read from the live setting afterward. Reasoning (brief
§14's own steer, adopted): Organization configuration can change later (if Na Pista ever supports switching an
Organization's operating currency); a historical Order must not silently change what currency its stored
amounts mean. This mirrors exactly the reasoning already applied to `OrderItem.unitPrice` (ADR-031) — snapshot
what happened, never derive history from current state.

**One currency per Order, no multi-currency Order.** Every `OrderItem` under an `Order` is implicitly in
`Order.currency` — no per-item currency field. This is not just "the simple option": it is structurally
guaranteed by the model (there is nowhere in the schema for an item to disagree).

**No currency conversion, no exchange-rate table, anywhere in this phase or in F23.**

## Alternatives

**Currency on Product instead of (or in addition to) Organization** — rejected: enables the exact
disagreement-with-Organization state the brief calls out; no requirement demonstrates a need for
multi-currency products within a single-currency business.

**No currency snapshot on Order (always resolve from Organization at read time)** — rejected per the brief's
own explicit steer (§14): a later Organization currency change would silently reinterpret every past Order's
stored numeric amounts under a new currency label, which is wrong regardless of whether the *numbers* are
immutable (`OrderItem.unitPrice` doesn't change, but what currency those numbers denote would, which is just as
misleading).

**Multi-currency Organization (a business invoicing in more than one currency)** — rejected for v1: no
requirement demonstrates it, and it would require solving conversion/display/reporting problems this phase is
explicitly told not to touch (brief §3: "Multi-currency conversion", "Exchange rates" are out of scope).

## Consequences
- (+) Exactly one place (`TenantSettings`/organization-level `currencyCode`, whichever F23 lands on) is the
  single source of truth for "what currency does this business sell in," with no possibility of disagreement
  elsewhere.
- (+) Historical Orders remain interpretable forever, independent of later configuration changes.
- (−) A business that genuinely needs to sell in more than one currency is not served by F23 — explicitly
  deferred, not silently ignored (matches ADR-027's posture on locations).
- (−) `TenantSettings` still does not exist as a real table; F23 must decide (as an implementation detail, not
  an architectural one) whether to introduce it now or place `currencyCode` directly on a Na Pista-owned
  extension of Organization data. Either is compatible with this ADR; neither is decided here (see
  `docs/f23a-report.md` "Unresolved questions").

## Future extension path
Multi-currency Organizations, currency conversion, and exchange rates are a distinct future module (its own
ADR, its own rate-source decision, its own rounding/precision questions per currency pair) — not an incremental
change to this one.
