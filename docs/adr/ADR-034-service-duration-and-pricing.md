# ADR-034 — Service Duration and Pricing Model

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F24A (spike)

## Context
F18's `domain-model.md` SD-2 already recommended `duration_minutes` (obligatory) and `price_minor` (optional,
"same rule as PD-4") for Service, at a conceptual stage before F23A's real money architecture existed. F24A
must fix the concrete representation for both, reusing F23A's now-proven money decisions (ADR-029/030/031)
rather than re-deriving them, and closing OD-09's duration-specific part (buffer, variable-duration).

## Decision

### Duration
**`durationMinutes integer`, `CHECK (duration_minutes > 0)`, no upper bound, any positive integer allowed**
(not constrained to multiples of 15/30/60). Evaluated against the brief's own four candidates (§8):
- **Integer minutes** (chosen): the natural unit for a human-performed service; trivial arithmetic for a
  future Scheduling module (`start + durationMinutes = end`, plain integer addition against a timestamp);
  trivial API representation.
- **Integer seconds** — rejected: no requirement demonstrates sub-minute precision for any real service
  (a haircut, massage, or consultation is never scheduled to the second); needless extra digits everywhere.
- **Numeric duration** — rejected: nothing demonstrates a need for fractional minutes; an integer is simpler
  and exactly as expressive for every real example in the brief (30/60/90).
- **Postgres `interval`** — rejected: more flexible than needed, awkward JSON serialization (ISO-8601
  duration strings, a new convention this codebase has never used), no simpler arithmetic than an integer for
  the one operation that matters (adding a length of time to a start timestamp).

**API representation: a plain JSON integer, not a decimal string.** This is a deliberate, reasoned exception
to the "money and quantity are decimal strings" convention (ADR-029/ADR-027): that convention exists
specifically to avoid IEEE-754 float imprecision on *fractional* decimal values. A bounded positive integer
(no real service runs for anywhere near `Number.MAX_SAFE_INTEGER` minutes) has no such risk — wrapping it in
a string would add ceremony without solving a problem that doesn't exist for this field.

**Granularity: no booking-grid quantization in Service itself** (F24 brief §9) — `durationMinutes` accepts any
positive integer; deciding the actual calendar slot grid (e.g., "appointments start on the hour or
half-hour") is Scheduling's (F26) concern, not the catalog's. Constraining it here would be exactly the
speculative, premature coupling CLAUDE.md §12/§14 rule out.

**Buffer/preparation/cleanup time: explicitly NOT part of Service in F24** (F18's own OD-09, still open,
narrowed here). Reasoning: buffer is fundamentally a *scheduling* concern (how much calendar time to block
around a booking), not a catalog-definition concern — and it plausibly varies by *who* performs the service
(a senior professional needing less cleanup time than a junior one) or *where* (a room needing turnover time),
neither of which exists yet. Forcing a `bufferMinutes` field onto `Service` now would guess at a shape neither
Professional (F25) nor Scheduling (F26) has defined. Deferred to whichever of those modules actually owns it,
once real requirements exist.

### Pricing (reuses ADR-029/ADR-031 exactly, extended to Service)
**`Service.price numeric(14,2)`, nullable.** `NULL` ("not yet priced") and `0` ("deliberately free — e.g. a
complimentary consultation") are distinct, both valid — identical semantics to `Product.price` (ADR-031), no
Service-specific reason to diverge. `CHECK (price IS NULL OR price >= 0)` — negative rejected, same as
Product. No price history, no price lists — the same minimum-model reasoning ADR-031 already gives.

### Currency (reuses ADR-030 exactly)
**No `currency` column on `Service`.** A Service's price is denominated in whatever currency its
Organization operates in (`AOA` today) — implicit, never redundantly stored, for the identical reason
ADR-030 gives for Product: storing it on both would allow the exact disagreement state ("Organization
currency = AOA, Service currency = USD") that decision already rules out. F24A found no Service-specific
reason to contradict the established Organization-level currency model (F24 brief §12's own explicit test).

### Future price/duration snapshot contract (F27 — documented now, not implemented)
The same historical-integrity principle ADR-031 established for `OrderItem` applies identically to the future
Appointment's service line: whatever F27 calls its "booked service" record (e.g. `AppointmentService`) must
snapshot, at Appointment-creation time:
- `serviceId` (reference)
- `serviceName` (snapshot — a later Service rename must not alter a past Appointment's record)
- `unitPrice` (snapshot — a later Service price change must not alter a past Appointment's value, exactly the
  Day-1/Day-2 example ADR-031 already documents for Product/OrderItem)
- `durationMinutes` (snapshot — **a Service-specific addition OrderItem never needed**, since a Service's
  *duration itself* is a fact about what was actually booked and performed; if it changes later, a past
  Appointment must still record how long it actually was)

`AppointmentService → Service → current Service.price/duration` must never be a valid path for computing a
historical Appointment's value or duration — restated now so F27 does not have to re-derive this reasoning.

## Alternatives

**`price_minor bigint` (F18's original PD-4 proposal)** — already superseded project-wide by ADR-029; not
re-litigated here. Service simply inherits the same `numeric(14,2)` decision Product uses.

**Duration as a decimal string like money/quantity** — rejected, reasoned above (no fractional-precision
problem exists for a bounded positive integer).

**A `bufferMinutes` field on Service now** — rejected; genuinely undecidable before Professional/Scheduling
exist (see reasoning above); explicitly deferred, not silently dropped.

## Consequences
- (+) Zero new money-representation machinery — `priceSchema`-equivalent validation for Service is a direct
  reuse of the exact pattern `products/schemas.ts` already implements.
- (+) Scheduling (F26) can compute `end = start + durationMinutes` on day one with no unit-conversion step.
- (−) No buffer/prep time exists yet — a real scheduling calculation in F26 will need to source it from
  wherever it ends up living (Professional config or Scheduling itself); Service alone is not sufficient for
  a complete availability calculation, which was never its job.

## Future extension path
Buffer time: additive, once Professional/Scheduling defines where it belongs. Price history/price lists: same
additive path ADR-031 already names for Product, unchanged. The Appointment-side snapshot: F27's own new
table/columns, requiring no change to `Service` itself.
