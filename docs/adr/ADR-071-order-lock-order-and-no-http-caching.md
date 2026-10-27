# ADR-071 — Stock rows locked in one global order; retryable 409 for rolled-back concurrent writes; no HTTP caching

- **Estado:** Accepted — implemented locally (branch `fix/order-lock-order-and-etag`; not deployed)
- **Data:** 2026-10-22
- **Origem:** Na Pista readiness audit (`projeto_ul/docs/architecture/NA-PISTA-READINESS-AUDIT-2026-10-22.md`, P1-1 and P1-4a), owner-authorized local fix

## Context

1. `confirmOrder` / `cancelOrder` move stock item by item, in the Order's item order (`created_at`); each movement
   locks that product's `inventory_balances` row. Two Orders holding the same products in opposite orders, confirmed
   at the same time, locked them in opposite orders: 29/30 audit rounds deadlocked. PostgreSQL rolled the victim back
   after `deadlock_timeout` (1 s) — stock stayed exact — but the client got `500 INTERNAL_ERROR`, with no hint that
   repeating the request was safe.
2. Express answers with an ETag and may answer 304. With one browser origin this is harmless; with a second browser
   interface it reproduces UL Platform's 2026-10-20 incident (Chrome revalidates a response cached for another
   same-site origin, Vercel strips the CORS headers from the 304, the fetch fails with status 0).

## Decision

- Order confirmation and cancellation move stock in **product-id order**, whatever the item order: concurrent
  transactions on overlapping products queue instead of deadlocking. Every multi-row stock lock must follow this order.
- A deadlock (40P01) or serialization failure (40001) that reaches the error handler is a **409
  `CONCURRENT_UPDATE`**: the transaction was rolled back as a whole, nothing was applied, the request can be repeated.
  Domains that give it their own meaning keep doing so first (appointments → `APPOINTMENT_CONFLICT`).
- No ETag and `Cache-Control: no-store` on every `/v1` response (same as UL Platform `db7b5d9`): API responses are
  per-caller bearer data and must never be cached or answered conditionally.

## Consequences

- The stock-movement history of one confirmation lists products in id order rather than item order (the Order's
  items themselves are unchanged).
- `GET` responses are always complete (200), never 304 — slightly more bytes, no stale cross-origin cache.
- Evidence: `tests/integration/orders.test.ts` (opposite-order confirms/cancels, 10 rounds) and
  `tests/unit/httpCachingAndConcurrency.test.ts`. The audit's 30-round probe (29/30 deadlocks before, 0/30 after) is kept
  apart from the regression suite, on the audit branch (`tests/audit/`), with the readiness report.
