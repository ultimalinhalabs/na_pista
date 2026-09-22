# ADR-026 — Customer Lifecycle

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F20's ADR-020 already established the two-state `ACTIVE|ARCHIVED` pattern for Products/Categories. F21 had to
decide whether Customer needs anything different.

## Decision
Same two states, same rule: `DELETE /customers/:id` archives (`status = ARCHIVED`), **never a physical
delete** — proven in `tests/e2e/customers-lifecycle.test.ts` ("archived, never physically deleted — still
readable by id") and `tests/integration/customers.test.ts`. No restore endpoint (`PATCH` with
`status: "ACTIVE"` already covers un-archiving using the same permission as any other update — no new
endpoint invented, matching F20's ADR-020 precedent exactly). Archived customers are excluded from the
default `status=ACTIVE` list filter but remain fully retrievable by id and via an explicit `status=ARCHIVED`
list query — the API never hides data by default, only the caller's own filter choice does.

**Why archiving matters here specifically:** a customer record is exactly the kind of data a future Orders or
Appointments module will hold historical references to ("this order was placed by customer X") — physically
deleting it would orphan that history the moment it exists, for no benefit today.

## Alternatives
Physical `DELETE FROM customers` — rejected for the same reason ADR-020 rejected it for Products: no
requirement demands it, and it forecloses future modules that will need the historical reference to keep
resolving.

## Consequences
- (+) Identical lifecycle mental model across every Na Pista resource built so far (Product, Category,
  Customer) — one pattern, not three.
- (+) Safe by construction for whatever future module ends up referencing a `customerId`.
- (−) Nothing enforces eventual deletion for genuine data-retention/privacy requirements (e.g. "erase this
  person's data on request") — not addressed in this slice; F18's OD-22 (privacy/PII policy) remains open and
  is the right place to resolve it, not something to improvise here.
