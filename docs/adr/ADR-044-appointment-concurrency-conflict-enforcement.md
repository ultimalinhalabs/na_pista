# ADR-044 — Appointment Concurrency & Booking Conflict Enforcement

- **Estado:** Accepted — implemented (F27)
- **Data:** 2026-09-25
- **Phase:** F27A (spike)

## Context

ADR-041 fixed the invariant "a successful Appointment write must not rely solely on a previous availability
read" and named a PostgreSQL exclusion constraint (F18 SD-4) as the leading candidate, leaving the final choice
to F27A. This ADR makes that choice, defines the write-time validation against F26, the transaction boundary,
and the error mapping. Evidence: a rolled-back probe against the project's real database (PostgreSQL 17.6,
Supabase; `btree_gist` 1.7 available, not yet installed) — `docs/f27a-report.md` §32.

## Decision

### The booking invariant

> For any organization *O* and Professional *P*, no two Appointments of *O*/*P* whose `status <> 'CANCELED'`
> may have overlapping intervals.

Occupying states: `SCHEDULED`, `COMPLETED` (and, by construction, any future non-canceled state). Releasing:
`CANCELED`. Capacity per Professional = 1 (ADR-041 D17).

**Interval semantics: half-open `[start_at, end_at)`.** A and B overlap iff
`A.start_at < B.end_at AND B.start_at < A.end_at`. Touching boundaries do **not** overlap: 10:00–11:00 and
11:00–12:00 can both exist — the same adjacency rule F26 already applies to working intervals
(`intervalsOverlap`). PostgreSQL: `tstzrange(start_at, end_at, '[)')` with the `&&` operator implements exactly
this (probe rows A/D).

### Mechanism — PostgreSQL exclusion constraint (chosen)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

ALTER TABLE na_pista.appointments
  ADD CONSTRAINT appointments_professional_no_overlap
  EXCLUDE USING gist (
    organization_id WITH =,
    professional_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status <> 'CANCELED');
```

**Why this guarantees the invariant** (not "we check before insert"):
1. An exclusion constraint is enforced by PostgreSQL on **every** `INSERT` and on every `UPDATE` that produces
   a new row version, regardless of which code path, module, script or future service issued it.
2. It is concurrency-safe at `READ COMMITTED`: when a transaction inserts/updates a row whose key conflicts
   with a row written by a *concurrent, uncommitted* transaction, PostgreSQL makes it **wait** for that
   transaction; if the other commits, the waiter fails with SQLSTATE `23P01 exclusion_violation`; if it rolls
   back, the waiter proceeds. Two racing bookings for overlapping intervals therefore cannot both commit —
   no application lock, no retry loop, no isolation-level change.
3. `organization_id WITH =` and `professional_id WITH =` scope the check to one tenant's one Professional:
   another tenant's rows can neither satisfy nor violate it (probe row E). `btree_gist` supplies the GiST
   equality operator class for `uuid` (verified on PG 17.6).
4. The partial predicate `WHERE (status <> 'CANCELED')` makes cancellation release the interval (probe row F)
   and makes un-canceling into an occupied interval impossible (probe row I). Negative predicate =
   future states occupy by default (fail-safe).
5. It covers **rescheduling** identically: an `UPDATE` of `start_at`/`end_at`/`professional_id` into an
   occupied interval fails with `23P01` (probe row H). Two concurrent reschedules of *different* appointments
   into the same target are resolved exactly like two inserts; two concurrent operations on the *same*
   appointment are serialized by the row lock (`SELECT … FOR UPDATE`, ADR-043).
6. The constraint's GiST index doubles as the index for "occupying appointments of P in a range" (probe plan:
   `Index Scan using appointments_professional_no_overlap`), which bookable-slot computation needs.

### Strategies evaluated (summary — full matrix in report §31)

| | Correct under concurrency? | Why not chosen |
|---|---|---|
| A. `SELECT` conflict + `INSERT` | **No** — both READ COMMITTED transactions see "free" and insert | classic TOCTOU; rejected |
| B. Row lock (`SELECT … FOR UPDATE` on the `professionals` row) | Yes, if every writer remembers | discipline-based; serializes all bookings of a Professional; any path that forgets = double booking |
| C. `pg_advisory_xact_lock(hash(org, professional))` | Yes, if every writer remembers | same discipline problem; invisible in schema; raw SQL/tools bypass it |
| D. `SERIALIZABLE` + retry | Yes, if **all** participating transactions are serializable | needs retry loop on `40001`, false-positive aborts, global isolation discipline |
| E. **Exclusion constraint** | **Yes, unconditionally, for every writer** | — chosen |
| F. Pre-generated slot rows + unique index | Only for a fixed grid | contradicts ADR-039 (no stored slots); breaks with arbitrary durations |

### Drizzle / migration feasibility

- `drizzle-orm` 0.45 `pg-core` has **no** `EXCLUDE` builder and no range column type (checked in
  `node_modules`); `drizzle-kit` 0.31 **does** support `generate --custom` (empty migration for hand-written SQL).
- F27: the table is declared normally in `src/db/schema/appointments.ts` (plain `timestamp(…, { withTimezone:
  true })` columns — no custom range type needed, the range is an index *expression*); a second, custom
  migration adds the extension and the constraint. `drizzle-kit generate` diffs its own snapshots, never the
  live database, so it will not try to drop an object it does not know about. `drizzle-kit push` must not be
  used against this schema (it is not used today). A regression test asserts the constraint exists in
  `pg_constraint` with `contype = 'x'`, so an accidental drop fails CI.
- The schema file documents the constraint in its doc comment (same practice as other hand-authored details).
- `btree_gist` is installed in Supabase's `extensions` schema. Note: per OD-16 the physical database is
  currently shared with UL Platform (separate schemas); a database-level extension is visible to both. This is
  an additive, inert object — **no UL Platform code or schema change** — but it is recorded here so it is not a
  surprise.

### Availability is advisory; the write is authoritative

- **Availability** (F26 + F27 bookable slots) answers "*can this Professional theoretically perform this
  Service at this time?*" — a projection, possibly stale the instant it is returned.
- **Appointment write** answers "*can this booking be committed now without conflicting with another?*" — the
  only authoritative answer, decided by the database constraint inside the write transaction.
- A client that saw a slot as free may still get `409 APPOINTMENT_CONFLICT`; that is correct behaviour.

### Booking outside availability — strict in F27

F27 **rejects** any create/reschedule whose start is not an F26 `serviceStartTimes` entry for that local date
(`409 APPOINTMENT_OUTSIDE_AVAILABILITY`). No override flag, no override permission, no stored override
reason. The operational escape hatch already exists: a manager with `scheduling.create` adds a date exception
(ADR-039) opening the extra hours, then books normally — the booking stays consistent with Scheduling, and the
exception itself is audited. (Caveat recorded in report §17: an exception replaces the whole day, so the
normal hours must be re-entered alongside the extra interval; the Console should prefill them.)

### Write-time validation against F26 (exact integration boundary)

F27 does **not** call F26 over HTTP and does **not** call `getAvailabilityOrThrow` (it throws on archived
entities with F26-specific semantics and reads outside the write transaction). It reuses F26's **pure engine**
and **repositories**:

1. Convert `start_at` (UTC instant) to the organization's local `(date "YYYY-MM-DD", time "HH:mm")` with
   `Intl.DateTimeFormat({ timeZone })` — UTC→local is unambiguous, no dependency needed.
2. `listScheduleRules` + `listScheduleExceptionsInRange(date, date)` (existing, executor-aware).
3. `computeAvailability({ rules, exceptions, from: date, to: date, durationMinutes })` (existing pure fn).
4. Require `localTime ∈ days[0].serviceStartTimes`. This single check encodes: working day, exception
   precedence, 15-minute grid anchored at interval start (`BOOKING_INCREMENT_MINUTES`), and "the whole duration
   fits inside one working interval" — exactly the contract the Console already displays.

`durationMinutes` is the live `Service.durationMinutes` on create, and the appointment's own
`end_at - start_at` on reschedule (never the current Service value). Local→UTC conversion (needed only to
*produce* slot instants for the Console) is a new small helper with ADR-040's DST contract (nonexistent local
time → slot skipped; ambiguous → earlier instant), unit-tested with a DST zone.

### Transaction boundary (create; reschedule is identical with a row lock first)

```
before tx:   Zod: shape, UUIDs, startAt ISO-8601 with offset, seconds/ms = 0, notes length
             timezone = getTimezoneOrThrow(tenant)                       -> 409 TIMEZONE_NOT_CONFIGURED
             now <= startAt <= now + 365 days                           -> 400 VALIDATION_ERROR
BEGIN (READ COMMITTED)
  [reschedule only] SELECT appointment FOR UPDATE; status = SCHEDULED    -> 404 / 409 INVALID_APPOINTMENT_STATE
  load Customer, Professional, Service via tx; ACTIVE checks            -> 404 / 409 *_ARCHIVED
  getAssociation(professional, service)                                  -> 404 NOT_FOUND
  F26 engine check on local date/time                                    -> 409 APPOINTMENT_OUTSIDE_AVAILABILITY
  INSERT / UPDATE appointments (snapshots on insert only)                -> 23P01 -> 409 APPOINTMENT_CONFLICT
  INSERT audit_events (same tx)
COMMIT
after:       recordUsage (fail-open, outside tx — existing convention)
```

- **Nothing is retried automatically.** `23P01` is a genuine business conflict, not a transient
  serialization failure; the client must choose another time.
- Existence/ACTIVE/association/availability checks are **not** concurrency guards and need no locks: a
  concurrent archive/schedule edit committing after our read is equivalent to "booked, then archived/edited",
  which ADR-042 already allows (archiving and schedule edits never invalidate existing appointments).
  Composite FKs still guarantee referenced rows exist in-tenant.
- Only the overlap invariant needs the database guarantee — and it has it.

### PostgreSQL error mapping

| Condition | HTTP | code | message (safe) |
|---|---|---|---|
| `23P01` and `constraint_name = 'appointments_professional_no_overlap'` | 409 | `APPOINTMENT_CONFLICT` | "The professional already has an appointment overlapping this time" |
| `23P01`, any other constraint (future) | 409 | `CONFLICT` | "Conflicting resource state" (global `errorHandler` fallback) |
| `23514` check violation | 500 `INTERNAL_ERROR` (logged) | — | validation must have caught it first — a bug, never a client-facing constraint name |
| `23503` FK violation | cannot happen after in-tx existence checks; 500 if it does | — | — |

Implementation: `isExclusionViolationError(error, constraintName?)` beside `isUniqueViolationError` in
`shared/errors.ts`, walking drizzle's `cause` chain (`code`, `constraint_name` from postgres.js). Never expose
the constraint name, SQL, or driver message. Tests assert the exact status/code/message and that the body
contains no constraint name.

### Idempotency — no `Idempotency-Key` in F27 (reasoned, not skipped)

A retried or double-clicked `POST` is by definition the same Professional + same interval, so the second
attempt **cannot** create a duplicate: it hits the constraint and returns `409 APPOINTMENT_CONFLICT`. The
invariant is itself the de-duplication mechanism for staff-created bookings. The residual risk is UX only (a
retry after a lost response reports "conflict" instead of returning the created resource); the Console handles
`409` after a network error by refreshing the day view. `PATCH`/cancel/complete are naturally idempotent by
state (row lock + state check). **Future:** public self-booking or third-party integrations must add an
`Idempotency-Key` header backed by a tenant-scoped key table storing the response — that is where a retry
genuinely needs the original result.

## Alternatives

See strategy table. Also rejected: application-level mutex (breaks with >1 process), deferring constraint
checks (`DEFERRABLE` — no benefit, later error), `SERIALIZABLE` for all Na Pista transactions (global cost).

## Consequences

- (+) The invariant holds for every writer, forever, including future modules and ad-hoc SQL.
- (+) Concurrency tests are straightforward: fire real concurrent writes, assert exactly one `201`.
- (+) The same index serves bookable-slot reads.
- (−) One database extension (`btree_gist`) and one hand-written migration outside Drizzle's schema DSL —
  guarded by a regression test.
- (−) Capacity > 1 (classes) cannot use this constraint as-is; it needs a different mechanism when required.

## Future extension path

Buffers (ADR-040 D11): store `blocked_end_at` (or buffer columns on `professional_services`) and index the
buffered range instead — same constraint shape. Resources/rooms: an additional exclusion constraint on
`(organization_id, resource_id, range)` where `resource_id IS NOT NULL`. Capacity > 1: counted admission
under an advisory/row lock on a capacity row, replacing the constraint only for capacity-managed services.

## Implementation note (F27)

Implemented as decided (migration `0008_appointments_no_overlap.sql`). One error-code refinement, no semantic
change: a start beyond the 365-day horizon is `400 BOOKING_HORIZON_EXCEEDED` (the F27 brief's code) instead of
the generic `400 VALIDATION_ERROR` named in the transaction-boundary sketch above; a start in the past remains
`400 VALIDATION_ERROR`. The cross-session waiting behaviour this ADR relied on was proven live in F27
(`tests/integration/appointments.test.ts`, "proof of blocking"). See `docs/f27-report.md` §16–§17.

**Error-mapping amendment found by F27's concurrency testing (documented, not silent).** Besides `23P01`, a
racing overlapping writer can receive `40P01 deadlock_detected`: an exclusion constraint inserts its index
entry before checking for conflicts, so two simultaneous overlapping writers can wait on each other and
PostgreSQL aborts one after `deadlock_timeout`. Observed ~1 in 125 racing writers on this database (and once in
the first E2E run, where the losers surfaced as HTTP 500). The invariant was never violated — only the loser's
error was wrong. Resolution: a `40P01` raised by the guarded appointment INSERT/UPDATE is mapped to
`409 APPOINTMENT_CONFLICT` (that statement can only wait on overlapping rows of the same Professional), still as
a single attempt with no retry. The mapping table above is extended accordingly; the mechanism is unchanged.
