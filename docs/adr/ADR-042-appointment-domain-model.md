# ADR-042 — Appointment Domain Model

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F27A (spike)

## Context

ADR-035/038/041 fixed the four-way boundary (`Service = WHAT`, `Professional = WHO`, `Scheduling = WHEN CAN`,
`Appointment = WHAT WAS / WILL BE BOOKED`). ADR-034 already fixed a snapshot contract for "the booked service"
(name, price, duration). F18's `domain-model.md` SD-4/SD-5 sketched "Customer required in v1" and "one
appointment = one service". F27A must freeze the concrete Appointment model, validated against the real F26
code (`src/modules/scheduling/availability.ts`, `service.ts`) and the real `customers`/`professionals`/
`services`/`professional_services` schema — inspected directly, not assumed.

## Decision

**An Appointment is one staff-committed reservation of one Professional's time, for one Service, for one
Na Pista business Customer, over one absolute time interval.** It owns booking state. It never owns working
hours (Scheduling), service definition (Service), or who-can-do-what (`professional_services`).

### Table (conceptual — F27 builds it)

```
appointments {
  id                   uuid PK
  organization_id      uuid NOT NULL                -- tenant
  customer_id          uuid NOT NULL                -- composite FK (org, customer_id) -> customers(org, id)
  professional_id      uuid NOT NULL                -- composite FK (org, professional_id) -> professionals(org, id)
  service_id           uuid NOT NULL                -- composite FK (org, service_id) -> services(org, id)
  start_at             timestamptz NOT NULL         -- absolute instant (ADR-040)
  end_at               timestamptz NOT NULL         -- absolute instant; end_at - start_at = booked duration
  status               text NOT NULL DEFAULT 'SCHEDULED'   -- SCHEDULED | COMPLETED | CANCELED (ADR-043)
  service_name         text NOT NULL                -- snapshot of services.name at booking
  service_price        numeric(14,2) NULL           -- snapshot of services.price at booking (NULL = unpriced)
  currency             text NOT NULL                -- snapshot, ADR-030 (AOA today)
  notes                text NULL                    -- one internal staff note
  cancellation_reason  text NULL
  canceled_at          timestamptz NULL
  completed_at         timestamptz NULL
  created_at, updated_at
}
```

Every field's reason is in `docs/f27a-report.md` §29. Deliberately absent: `duration_minutes` (derived, see
below), customer/professional name snapshots, `payment_status`, `confirmed_at`, `metadata jsonb`,
`location_id`/`resource_id`, recurrence fields, `canceled_by` (audit owns the actor), `idempotency_key`
(ADR-044 §Idempotency).

### Relationships — all four mandatory in F27

- **Organization** — tenant, never client-trusted (`req.tenant`).
- **Customer — required.** An appointment is a future commitment to attend someone; unlike an Order (an
  instantaneous walk-in sale, where `customerId` is nullable, ADR-032), there is no appointment without a
  person to attend or contact. "Block time without a customer" is not an Appointment — it is a Scheduling
  exception (ADR-039), which already exists. Guest/anonymous booking is out of scope; a walk-in is recorded by
  creating a minimal Customer (name only is valid, ADR-024). Future self-booking does not change this: a
  self-booking flow must resolve or create a Na Pista Customer before booking (ADR-043 §Self-booking).
  The Customer is the **Na Pista business Customer** (ADR-024/025), never a UL Platform User.
- **Professional — required.** One Appointment → one Professional (ADR-041 D18).
- **Service — required.** One Appointment → one Service (ADR-035, ADR-041 D19).

All three are **composite FKs keyed on the appointment's own `organization_id`** — the exact mechanism
`professional_services`/`order_items` already prove — so a cross-tenant reference is unrepresentable in the
database, not merely rejected by application code.

### Snapshot decision — option B (reference + targeted snapshot)

| Attribute | Treatment | Why |
|---|---|---|
| `service_id` | reference (FK) | identity of what was booked; reporting/grouping |
| service name | **snapshot** `service_name` | ADR-034; a rename ("Corte" → "Corte Premium") must not rewrite history |
| duration | **snapshot, implicitly** as `end_at - start_at` | ADR-034; stored once, not twice (see Time model) |
| price | **snapshot** `service_price` | ADR-034/ADR-031 Day-1/Day-2 rule |
| currency | **snapshot** `currency` | ADR-030, mirrors `orders.currency` |
| description, status | reference only | not booking facts |

Worked example: Service "Personal Training" 60 min / 10 000,00 → Appointment A booked → Service becomes
90 min / 15 000,00. Appointment A still reads 60 min (its `end_at - start_at`) and 10 000,00 — forever. New
appointments get 90 / 15 000,00. `appointment → service → current price/duration` is never a valid path for
a historical value.

**Price:** `service_price` is nullable because `services.price` is nullable (ADR-034: `NULL` = not yet
priced, `0` = free). Unlike `order_items`, an unpriced Service **can** be booked — booking is reservation of
time, not a sale; F27 does not require a price. Representation reuses ADR-029 exactly (`numeric(14,2)`,
decimal string on the wire). The price is captured once, at creation, and is **not** re-captured on
reschedule (a reschedule moves the same booking; it does not re-quote it). Appointment is not a payment,
invoice or ledger record; a future billing/payment flow (Orders or Micha Express via API) reads
`service_price`/`currency` as the **agreed booking price**, and remains free to apply its own pricing rules.

**No Customer/Professional name snapshot.** Customer and Professional are live, never-deleted records owned
by the same organization; their name edits are corrections that *should* propagate. Service is different
because its name is a commercial offer whose meaning can change (ADR-034 already required the snapshot).

### Time model — `start_at` + `end_at`, both `timestamptz`, no stored duration

- ADR-040: an Appointment is an absolute instant, `timestamptz`, ISO-8601 on the wire
  (`"2026-10-05T09:00:00Z"`, offsets accepted, normalized to UTC on output). Never a local string.
- **`end_at` must be a stored column**: the conflict constraint (ADR-044) indexes `tstzrange(start_at, end_at)`;
  an index expression of `start_at + duration * interval '1 minute'` is **not possible** because
  `timestamptz + interval` is `STABLE`, not `IMMUTABLE`, in PostgreSQL.
- **No `duration_minutes` column**: `end_at - start_at` *is* the booked duration; storing it again would create
  a second source of truth needing its own consistency constraint. The API exposes `durationMinutes` as a
  derived field.
- `CHECK (end_at > start_at)`. At creation `end_at = start_at + Service.durationMinutes` (computed server-side
  from the live Service, in absolute minutes); the client never sends `end_at`.
- Organization timezone (`organization_settings`) is required to create/reschedule (availability validation
  needs it) — `409 TIMEZONE_NOT_CONFIGURED`, fail closed, no fallback (ADR-040). Changing the organization
  timezone later never alters stored appointments (they are absolute); only their local display changes.

### Archived entities

| | Existing appointments | New appointment | Reschedule (time/professional change) | Cancel / complete |
|---|---|---|---|---|
| Customer archived | remain, valid | `409 CUSTOMER_ARCHIVED` | `409 CUSTOMER_ARCHIVED` | allowed |
| Professional archived | remain, valid | `409 PROFESSIONAL_ARCHIVED` | target Professional must be ACTIVE | allowed |
| Service archived | remain, valid | `409 SERVICE_ARCHIVED` | `409 SERVICE_ARCHIVED` | allowed |
| `professional_services` removed | remain, valid | `404 NOT_FOUND` (same as F26: not distinguishing "not associated") | target pairing must exist | allowed |

Rule: **every write that places an operational commitment at a (new) time requires Customer, Professional and
Service all ACTIVE and associated**; closing out an existing commitment (cancel/complete) never does.
Archiving never deletes or cancels appointments (no cascade); reactivation changes nothing about history.

### Scheduling changes do not rewrite appointments

Editing a weekly schedule, adding an exception, or archiving a Professional never cancels, moves, or
invalidates existing appointments. Availability is validated **at booking time**; later schedule edits are
not retroactive. (A Console warning about orphaned appointments is deferred.)

## Alternatives

- **A — reference Service only** — rejected: historical price/name/duration silently change (ADR-034 violation).
- **C — full Service snapshot (description, status, …)** — rejected: copies non-booking facts; no consumer.
- **Separate `appointment_services` line table (ADR-034's "AppointmentService" wording)** — rejected for F27:
  with one Service per Appointment (ADR-041 D19) a line table adds a join for zero benefit; ADR-034's contract
  (what must be snapshotted) is satisfied by inline columns. It remains the additive path for multi-service.
- **Optional Customer (Order-style)** — rejected, see above; would also complicate future self-booking.
- **`start_at` + `duration_minutes`** — rejected: cannot back the range index (STABLE expression).
- **`start_at` + `end_at` + `duration_minutes`** — rejected: redundant; no invariant needs it.
- **Local date + local time columns** — rejected: ambiguous under DST, contradicts ADR-040.
- **Generic `metadata jsonb`** — rejected: no requirement; becomes a dumping ground.

## Consequences

- (+) Purely additive: zero changes to `services`, `professionals`, `professional_services`,
  `customers`, `professional_schedule_*`, `organization_settings`. F26 is consumed, not redesigned.
- (+) Tenant safety is structural (three composite FKs); history is immutable in meaning.
- (−) Staff cannot book without a Customer record (walk-in requires a minimal Customer first) — deliberate.
- (−) An appointment's duration cannot be edited independently of its Service in F27 — a custom-duration
  booking is deferred (additive: a validated `durationMinutes` override on create).

## Future extension path

Multi-service → `appointment_services` join table carrying today's snapshot columns per line.
Multi-professional → `appointment_professionals` (ADR-041 D18). Location/Resource → nullable `location_id`/
`resource_id` plus an additional exclusion constraint per resource (ADR-044). Guest self-booking → resolve/
create a Customer first; the model is unchanged.
