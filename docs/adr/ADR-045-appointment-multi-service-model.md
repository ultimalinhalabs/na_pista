# ADR-045 — Appointment Multi-Service Model

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F28A (spike) — implementation slice F28E (see `docs/f28a-report.md` §12)

## Context

**Current state (F27, verified in code):** `appointments` carries exactly one `service_id` (composite FK) plus the
snapshots `service_name`, `service_price`, `currency`; the booked duration is `end_at − start_at` (ADR-042).
`createAppointment` reads ONE Service, checks ONE `professional_services` row, and validates availability with that
Service's `durationMinutes`. ADR-041 D19 / ADR-042 named `appointment_services` as the additive path.

**Problem:** a customer often books several services in one visit (e.g. corte + barba). Today that is two
back-to-back appointments: two lifecycles, two cancellations, no single "visit" to reschedule, and no total.

## Decision

**A line table, `appointment_services`, becomes the single source of truth for what was booked; the F27 columns on
`appointments` are kept as a deprecated mirror of line 1 during an explicit expand → contract transition.**

```
appointment_services {
  id                uuid PK
  organization_id   uuid NOT NULL
  appointment_id    uuid NOT NULL   -- composite FK (org, appointment_id) -> appointments(org, id)
  service_id        uuid NOT NULL   -- composite FK (org, service_id)     -> services(org, id)
  position          integer NOT NULL CHECK (position >= 1)   -- execution order
  service_name      text NOT NULL                -- snapshot
  service_price     numeric(14,2) NULL           -- snapshot (NULL = unpriced), CHECK >= 0
  duration_minutes  integer NOT NULL CHECK (> 0) -- snapshot of Service.durationMinutes at booking
  created_at        timestamptz NOT NULL
  UNIQUE (organization_id, appointment_id, position)
  UNIQUE (organization_id, appointment_id, service_id)
}
```

(`appointments` needs a new composite-FK target `UNIQUE (organization_id, id)` — the same one-line addition F23/F25
made to `customers`/`services` the first time something referenced them.)

- **Cardinality:** 1..10 lines per appointment (Zod cap 10; ≥ 1 enforced by the domain service — a cross-table
  "at least one child" rule is not expressible as a plain constraint). A Service appears at most once per appointment
  (no demonstrated need for "the same service twice"; relaxing it later only drops a unique index).
- **Order:** `position` 1..n, contiguous, services performed back-to-back inside the appointment's interval.
- **Duration:** `Σ duration_minutes = end_at − start_at` (the customer-visible interval). Enforced in the service layer
  at write time and asserted by an integration test on every write path; per-line durations are snapshots, so a later
  Service edit never changes any line.
- **Currency:** stays one column on `appointments` (ADR-030: single operating currency per appointment). Not per line —
  per-line currency would allow the disagreement state ADR-030 exists to rule out.
- **Total price:** **computed on read** (`SUM(service_price)`), never stored: lines are immutable after booking, so a
  stored total would only add a second source of truth. `totalPrice = null` if **any** line is unpriced (an unknown
  component makes the total unknown — never silently treated as 0).
- **Professional compatibility:** the (responsible) Professional must be associated through `professional_services`
  with **every** Service in the appointment; every Service must be ACTIVE (booking and reschedule, as in F27).
- **Availability:** unchanged engine — `computeAvailability` is called with `durationMinutes = Σ lines` (plus buffers,
  ADR-046). No new availability logic.
- **Conflict:** unchanged — the interval lives on `appointments`; lines never carry time.
- **Lifecycle:** lines have none of their own. They are immutable after booking: changing the set of services is a
  new booking (cancel + create), exactly as F27 made `serviceId` immutable. Reschedule moves the interval and keeps
  every line.
- **Single-service appointments** are simply appointments with exactly one line — no special case.

### Migration strategy (expand → contract, no breaking step inside one release)

1. **Expand (F28E):** create `appointment_services` + `appointments(organization_id, id)` unique index; **backfill** one
   line per existing appointment (`position 1`, `service_id`, `service_name`, `service_price`,
   `duration_minutes = end_at − start_at` in minutes). From then on every write creates lines in the same
   transaction and ALSO writes `appointments.service_id/service_name/service_price` = line 1 (compatibility mirror,
   same transaction, covered by a consistency test). All reads come from lines.
2. **Contract (later, separate slice, explicit entry criteria):** once the Console and every known API consumer read
   `services[]`, drop the mirror columns (`service_id`, `service_name`, `service_price`, their FK and index). Entry
   criteria: no code path reads them (grep + test), deprecation notice published in `appointments-api.md` for at least
   one release.
3. **Rollback:** during expand the F27 columns stay complete and correct, so rolling back the application is safe;
   the new table can be dropped without data loss for single-service appointments. After a multi-service appointment
   exists, rollback would lose lines 2..n — the contract step is therefore the point of no return and is gated.

### API impact

- `POST` accepts `serviceIds: uuid[]` (1..10, ordered) **or** the F27 `serviceId` (treated as `[serviceId]`); both
  present → `400`. `.strict()` stays.
- Representation adds `services: [{ position, serviceId, serviceName, servicePrice, durationMinutes }]` and
  `totalPrice`; `serviceId/serviceName/servicePrice` remain (deprecated, = line 1) until contract.
- `GET ?serviceId=` matches appointments having that Service in **any** line (`EXISTS`).
- `bookable-slots` accepts `serviceIds` (repeatable) in addition to `serviceId`; duration = Σ.
- Errors unchanged; "not associated with one of the services" stays `404 NOT_FOUND` (existing convention).

### Other impacts

- **UI:** create flow allows adding/reordering services (bounded list), review shows per-line price and total;
  detail lists lines. The Console keeps working unchanged during expand (deprecated fields still present).
- **Tenant isolation:** both composite FKs keyed on the line's own `organization_id`; repository asserts tenant;
  cross-tenant Service ids → 404 as today.
- **Authorization:** unchanged (`appointments.create/update`).
- **Audit:** `appointment.created` metadata gains `serviceIds` (ordered). No per-line audit events.
- **Usage:** unchanged (one `api_requests` unit per committed booking, not per line).
- **Testing:** unit (Σ duration, total-price null rule, input normalization `serviceId`→`serviceIds`); integration
  (backfill correctness on real rows, mirror consistency, association required for every service, archived service in
  any line → 409, snapshot immutability per line, cross-tenant line FK rejection); E2E (create/list/filter with
  multi-service, deprecated single-service contract still honored); concurrency unchanged (interval authority is the
  same constraint).

## Alternatives

- **Replace `service_id` columns in one breaking migration** — rejected: breaks the F27 API and the Console in one
  step, no rollback window.
- **Primary service on `appointments` + extra services in a side table** — rejected: two shapes for one concept;
  every read/sum would need to merge two places.
- **Linked consecutive appointments (group id)** — rejected: N lifecycles for one visit, partial cancellation
  ambiguity, N rows in the conflict constraint for one occupation.
- **Stored `total_price`** — rejected (derivable from immutable lines; second source of truth).
- **JSON array of services on `appointments`** — rejected: not constrainable (FKs, per-line snapshots), and the
  project's "rows, not arrays" convention (ADR-039).

## Consequences

- (+) One visit = one appointment = one interval = one conflict row; the F27 conflict authority is untouched.
- (+) Fully additive with a safe rollback window; F27 clients keep working through expand.
- (−) A transitional compatibility mirror (bounded, tested) until the contract step.
- (−) The Σ-duration rule is application-enforced (tested), not a database constraint.

## Deferred

Per-line professional assignment (different professionals for different lines of one visit), inter-service gaps,
per-line pricing overrides/discounts, same service twice.
