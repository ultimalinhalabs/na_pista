# ADR-049 — Appointment Creation Idempotency (`Idempotency-Key`)

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F28A (spike) — implementation slice F28C

## Context

**Current state (F27):** no idempotency. ADR-044 and `docs/api/appointments-api.md` §Idempotency already state the
gap precisely:

| Situation | F27 behaviour |
|---|---|
| duplicate booking of the same interval (double click, two tabs) | second write → `409 APPOINTMENT_CONFLICT` |
| retry after the first request **committed** but the response was lost | retry → `409 APPOINTMENT_CONFLICT` — the client never learns its booking succeeded |
| retry after the first request failed before commit | safe; nothing was written |

**CONFLICT SAFETY ≠ IDEMPOTENCY.** The exclusion constraint guarantees *there are never two bookings*; it does not
guarantee *a retried request returns the result of the first one*. A retry of a successful booking is reported as a
failure, and a retry whose interval no longer conflicts (e.g. the first booking was canceled meanwhile) creates a
**second** appointment. Real idempotency needs a record of "this request already happened, here is its result".

## Decision

### Table

```
idempotency_keys {
  organization_id   uuid NOT NULL
  operation         text NOT NULL   -- 'appointments.create' (the only operation in F28C)
  key               text NOT NULL   -- client-supplied, 8..128 chars, [A-Za-z0-9_-]
  actor_type        text NOT NULL   -- 'user' | 'service'
  actor_id          text NOT NULL
  request_hash      text NOT NULL   -- SHA-256 hex
  resource_type     text NULL       -- 'appointment'
  resource_id       uuid NULL
  response_status   integer NULL    -- 201
  created_at        timestamptz NOT NULL DEFAULT now()
  expires_at        timestamptz NOT NULL           -- created_at + 24h
  PRIMARY KEY (organization_id, operation, key)
}
```

A defined infrastructure concept (not a generic entity table): one row = one completed idempotent request. No JSONB:
the durable result of a create is the created resource, referenced by id — storing a response-body snapshot would
duplicate customer data (notes) in a second table for no gain.

### Semantics

- **Header:** `Idempotency-Key` on `POST /appointments`, **optional** (absent → exact F27 behaviour, fully backward
  compatible). The Console always sends one per submit attempt (a UUID generated when the form is submitted, reused
  on network retry of that same submit).
- **Scope:** `(organization_id, operation, key)`. The organization comes from the validated tenant context, never from
  the request body → a key can never be replayed across tenants. The actor must also match (below).
- **Request hash:** SHA-256 of canonical JSON of `{ operation, pathParams, body }`, where `body` is the **Zod-parsed**
  body (normalized: `startAt` as UTC ISO, trimmed notes, `serviceId`→`serviceIds` once ADR-045 exists), keys sorted.
  Two spellings of the same instant hash identically.
- **Transaction boundary — the key row commits atomically with the booking:**
  1. Before the transaction: header shape check (`400 VALIDATION_ERROR`), Zod, hash, booking window, timezone —
     failures here write nothing.
  2. First statement **inside** the booking transaction:
     `INSERT … ON CONFLICT (organization_id, operation, key) DO NOTHING RETURNING …`.
     - Inserted → proceed with the normal F27 booking; after the INSERT of the appointment, `UPDATE` the key row with
       `resource_id`, `response_status = 201`; commit.
     - Conflict → read the existing row: expired → delete it and insert again (same transaction); same `request_hash`
       and actor → **replay**: end the transaction without writing, return the stored status (`201`) with the
       **current** representation of `resource_id` (tenant-scoped read) and header `Idempotency-Replayed: true`;
       different hash or different actor → `409 IDEMPOTENCY_KEY_REUSED`.
  3. Any failure in the booking (validation, `APPOINTMENT_CONFLICT`, archived resources, 500) **rolls back the key row
     too** → the key is free and a retry re-executes. Failures are never replayed; only committed successes are.
- **Concurrent requests with the same key:** the second `INSERT … ON CONFLICT` blocks on the first transaction's
  uncommitted unique-index entry (the same PostgreSQL waiting mechanism as ADR-044). If the first commits → the second
  sees the row → replay. If the first rolls back → the second inserts and executes. No `IN_PROGRESS` state and no lock
  timeout logic are needed, because the key and its result are one transaction.
- **Commit happened, response lost:** retry → row exists → replay `201` with the appointment. This is the case F27
  cannot handle.
- **Replay reflects current state:** if the appointment was canceled after creation, the replay returns it as
  CANCELED with the original `201`. Deliberate: the key promises "this create happened and here is that appointment",
  not a frozen copy.
- **TTL:** 24 hours (`expires_at`). Expired rows are treated as absent (replaced on reuse) and purged by the housekeeping
  tick defined in ADR-050 (`DELETE … WHERE expires_at < now()`).
- **Audit / usage on replay:** none (nothing was written). Only the original execution audits and meters.
- **Other operations:** not in F28C. PATCH reschedule sets an absolute target (a repeated identical PATCH converges to
  the same state; the only side effect is a duplicate audit row); cancel/complete/no-show are guarded by state (a
  repeat gets `409 INVALID_APPOINTMENT_STATE`, never a double effect). Extending the table to them is additive (new
  `operation` values) when a public/integration consumer needs it.

### Impacts

- **Migration:** one new table (additive). Rollback: drop it; behaviour returns to F27.
- **API:** optional header, new error code `409 IDEMPOTENCY_KEY_REUSED`, response header `Idempotency-Replayed: true`.
- **UI:** Console generates and reuses the key per submit; on replay it simply navigates to the returned appointment.
- **Tenant isolation:** org in the primary key + tenant-scoped replay read. **Authorization:** unchanged — a replay still
  passes the route's permission/entitlement gates first.
- **Testing:** unit (canonical hash: equivalent bodies equal, different bodies differ); integration (same key twice →
  one row + replay; different body → 409; different actor → 409; failure releases key; expired key re-executes;
  cross-tenant same key → independent); **concurrency** (two simultaneous requests with the same key → exactly one
  appointment, the other replays; two simultaneous requests with different keys for the same slot → one 201 and one
  `APPOINTMENT_CONFLICT` — conflict safety still independent of idempotency); E2E (lost-response simulation: repeat the
  identical request after success → 201 replay with the same id).

## Alternatives

- **Rely on the exclusion constraint** — rejected (the whole point of this ADR).
- **Store the full response body (JSONB)** — rejected: PII duplication, and a JSONB snapshot where a resource id is the
  real result.
- **`IN_PROGRESS` row committed before the booking** — rejected: needs crash recovery/timeouts; the single-transaction
  design gets the same concurrency behaviour from the unique index.
- **Deduplicate on a natural key (customer + professional + start)** — rejected: legitimately repeated bookings of the
  same slot after a cancellation would be silently swallowed.
- **Redis/in-memory store** — rejected: not transactional with the booking; lost on restart.

## Consequences

- (+) Exactly-once *effect* for booking retries within 24h, distinct from and complementary to conflict safety.
- (−) One extra row and index per keyed create; replay responses reflect current state (documented).
