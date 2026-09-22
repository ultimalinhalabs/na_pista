# ADR-024 — Customer Domain Model

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F21 needed Customers to become a real, shared primitive future Commerce (`Customer → Order → Products`) and
Service (`Customer → Appointment → Service → Professional`) flows can both depend on — without coupling it to
either one, and without growing into a CRM.

## Decision
Minimal `Customer`: `id, organizationId, name, email?, phone?, notes?, status, createdAt, updatedAt`. No FK to
Products/Orders/Services/Appointments (none of those exist as tenant-scoped references from Customer — the
dependency runs the other way, when those modules are eventually built). No date of birth, gender, tax number,
address hierarchy, loyalty points, segments, lead score, LTV, avatar, payment/billing fields — none justified
by any requirement seen so far (F21 brief §3).

**Search** (`q` on name/email/phone, plain `ILIKE`, tenant-scoped) is the one piece of real query logic beyond
CRUD — proven in `tests/integration/customers.test.ts`. No trigram/full-text index added: at this scale a plain
`ILIKE '%term%'` on an indexed-by-tenant table is adequate, and a `pg_trgm` GIN index would be exactly the kind
of speculative infrastructure F21 brief §6/§11 rules out without a demonstrated need.

**No tenant-scoped uniqueness** on name/email/phone. Real businesses have customers who share a phone (family
members), have no email, or share a common name — a uniqueness constraint would reject legitimate data with no
requirement asking for it. The `409`/`isUniqueViolationError` machinery from F20 is preserved untouched and
will fire the moment a real constraint is ever added; none exists today.

**Phone** validated as a loose international shape (`^\+?[0-9()\-\s]{7,20}$`) — works naturally with Angolan
numbers (`+244...`) without becoming Angola-specific, and without adding a phone-number-parsing dependency the
project has no existing convention for (F21 brief §8).

## Alternatives
A richer CRM-shaped record (segments, LTV, loyalty, tax number) — rejected outright, explicitly listed as
out-of-scope in the brief. A `pg_trgm`-backed search index — rejected as premature optimization; revisit if a
real customer base size demonstrates `ILIKE` is too slow.

## Consequences
- (+) Both a Commerce and a Service module can reference `customerId` later without this model needing to
  change — nothing here assumes either domain.
- (+) Search is real and tenant-scoped, proven against actual Postgres data, not just a schema.
- (−) No uniqueness protection means duplicate-looking customer records are possible; a future module that
  needs deduplication has to build it itself, deliberately, when a real need appears.
