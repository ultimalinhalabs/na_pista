# ADR-047 — Additional Conflict Authorities: Participating Professionals & Resources (Locations deferred)

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F28A (spike) — implementation slices F28G (participants) and F28H (resources); both depend on ADR-046

## Context

**Current state (F27):** exactly one `professional_id` per appointment; the only conflict authority is
`appointments_professional_no_overlap` on the `appointments` row. ADR-041 D18 named `appointment_professionals` as the
additive path; ADR-039 named resources/locations as deferred.

**Problem:** some bookings need several Professionals at once (a two-person massage, trainer + assistant) or a
physical asset that cannot be double-booked (a room, a chair, a machine). Each such thing needs its own
"no overlap" guarantee, and that guarantee must stay a PostgreSQL guarantee — an application-level SELECT check is
exactly the TOCTOU pattern ADR-044 rejected.

**Hard constraint:** an exclusion constraint only sees columns of its own table. A conflict across
"professional P responsible in A" and "professional P assisting in B" is only detectable if both facts are rows of
**one** table carrying the interval. A copied interval can drift unless the database keeps it in sync.

## Decision — one pattern, applied twice

**Assignment rows that carry a database-synchronized copy of the appointment's occupied interval and status, each
table with its own exclusion constraint.**

`appointments` gains a cascade-target key: `UNIQUE (organization_id, id, occupied_start_at, occupied_end_at, status)`.
Each assignment table references it with `FOREIGN KEY (organization_id, appointment_id, occupied_start_at,
occupied_end_at, status) REFERENCES appointments (...) ON UPDATE CASCADE`. Therefore:

- a reschedule (`UPDATE appointments` of the occupied bounds) **cascades** into every assignment row, and each
  assignment table's exclusion constraint re-checks the new interval **inside the same statement** — any clash aborts
  the whole reschedule atomically;
- a status change (cancel) cascades, so the partial predicate `status <> 'CANCELED'` releases every assigned
  professional/resource at once;
- an assignment row can never disagree with its appointment (any direct divergent write fails the FK).

All four properties were proven on the project's PostgreSQL 17.6 with a rolled-back probe (`docs/f28a-report.md`
§3.3). Tenant and entity FKs are composite on the row's own `organization_id`, as everywhere else.

### Participating professionals — `appointment_professionals` (slice F28G)

```
appointment_professionals {
  organization_id, appointment_id, professional_id          -- PK (organization_id, appointment_id, professional_id)
  role              text NOT NULL CHECK (role IN ('RESPONSIBLE','ASSISTING'))
  occupied_start_at, occupied_end_at, status                 -- cascade copy (FK above), never written independently
  created_at
  FK (organization_id, professional_id) -> professionals
  UNIQUE (organization_id, appointment_id) WHERE role = 'RESPONSIBLE'      -- exactly one responsible (at most one by index; at least one by the deferred FK below)
  EXCLUDE USING gist (organization_id WITH =, professional_id WITH =,
                      tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&) WHERE (status <> 'CANCELED')
}
```

- **Every** participating Professional — including the responsible one — has a row; this table is the professional
  conflict authority for multi-professional bookings.
- `appointments.professional_id` **stays** and means *the responsible Professional* (display, filtering, F27 API).
  Consistency is enforced by a `DEFERRABLE INITIALLY DEFERRED` composite FK `appointments (organization_id, id,
  professional_id) -> appointment_professionals (organization_id, appointment_id, professional_id)`, checked at commit
  (rows are inserted in the same transaction).
- The F27 constraint on `appointments` stays (strict subset of what the participants table checks — it can never
  reject something the new table would accept). Dropping it is an optional later cleanup, not part of F28.
- **Shared interval:** all participants are occupied for the whole occupied interval (no per-participant
  sub-intervals — deferred).
- **Cardinality:** 1..5 participants (Zod), exactly one RESPONSIBLE.
- **Rules:** every participant ACTIVE at booking/reschedule; the responsible Professional associated with every
  Service (ADR-045); each assisting Professional associated with at least one of the appointment's Services; the start
  must be valid in **every** participant's F26 availability (the unchanged engine, called once per participant).
  Buffers come from the responsible Professional (ADR-046).
- **Archived participant:** existing appointments untouched; reschedule requires all participants ACTIVE — the staff
  fix is to PATCH the participant set (remove/replace the archived assistant) in the same request.
- **Backfill:** one RESPONSIBLE row per existing appointment (from `professional_id` and its occupied bounds).
- **API:** create accepts `professionalIds: uuid[]` with the first = responsible (or F27 `professionalId` alone);
  representation adds `professionals: [{ professionalId, role }]`; `GET ?professionalId=` matches any participant;
  PATCH may replace the set (SCHEDULED only). A participant clash maps to `409 APPOINTMENT_CONFLICT` (new constraint
  name added to `mapBookingWriteError`; `40P01` already mapped).
- **Bookable slots:** intersection across the requested participants (each computed with the unchanged engine and
  occupying assignments).

### Resources — `resources` + `appointment_resources` (slice F28H)

"Resource" has a defined domain here: **a bookable physical asset of one organization (room, chair, equipment) that
can serve at most one appointment at a time.** It is not a generic entity table.

```
resources {
  id, organization_id, name, status ('ACTIVE'|'ARCHIVED'), created_at, updated_at
  UNIQUE (organization_id, id)
}
appointment_resources {
  organization_id, appointment_id, resource_id           -- PK
  occupied_start_at, occupied_end_at, status             -- cascade copy
  FK (organization_id, resource_id) -> resources
  EXCLUDE USING gist (organization_id WITH =, resource_id WITH =,
                      tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&) WHERE (status <> 'CANCELED')
}
```

- **Capacity:** exactly 1 (what the exclusion constraint expresses). **Capacity > 1 is deferred** — it needs counted
  admission, a different mechanism (ADR-044 "future extension").
- **Assignment:** explicit — staff choose 0..3 resources per appointment. No "service requires resource type" rule, no
  automatic allocation, no resource schedules (a resource is available whenever it is not booked) — all deferred.
- **Errors:** a resource clash maps to a new `409 RESOURCE_CONFLICT` (distinct from `APPOINTMENT_CONFLICT` so the UI
  can say *which* thing is taken). A `40P01` deadlock carries no constraint name, so it keeps the generic
  `APPOINTMENT_CONFLICT` mapping (F27 `mapBookingWriteError`): "the booking lost a race — refresh availability".
- **Authorization:** new `resources.read/create/update` (OWNER/ADMIN/MANAGER full, STAFF read) for the resource
  catalog; assigning a resource to an appointment is part of `appointments.create/update`.
- **Entitlement:** `catalog.enabled` (no new Platform entitlement — same reasoning as ADR-044/F27).
- **Audit:** `resource.created/updated` (catalog); appointment audit metadata lists `resourceIds`.

### Locations — defined as a different concept, and **deferred**

A **Location** is where the organization operates (a branch/site). It is **not** a conflict authority (a location hosts
many simultaneous appointments) — so it must not be modelled as a resource. Its real impact is on **Scheduling**
(a Professional works at location X on Mondays) and **time** (ADR-040: a location may override the organization
timezone). Introducing it therefore reopens ADR-039/040 extension points (`professional_schedule_rules.location_id`,
per-location timezone resolution in availability and appointment conversion), which has no demonstrated requirement.
Recorded model for when it is triggered: `locations {id, organization_id, name, timezone NULL, status}`,
nullable `appointments.location_id`, nullable `resources.location_id`, nullable `professional_schedule_rules.location_id`.
**Trigger:** a tenant with more than one physical site.

### Migration strategy

Both tables are new (purely additive). F28G additionally: the `appointments` cascade-target unique index, the
participants backfill, and the deferred FK (added `NOT VALID` then `VALIDATE`d after backfill). Rollback: drop the new
tables/FK; the F27 column + constraint still hold the responsible professional.

### Testing strategy

Integration + concurrency on real PostgreSQL, same discipline as F27: assistant-vs-responsible clash across two
appointments; reschedule cascade clash aborts atomically and leaves participants/resources unmoved; cancel releases all
participants/resources; raw divergent write on an assignment row fails the FK; deferred FK rejects an appointment
without its responsible participant row; concurrent bookings sharing only an assistant → exactly one wins; resource
double-booking race → exactly one wins with `RESOURCE_CONFLICT`; cross-tenant assignment FKs rejected.

## Alternatives

- **Application-level conflict checks for extra professionals/resources** — rejected (ADR-044 TOCTOU).
- **One linked appointment per professional (group id)** — rejected: duplicated customer/service/lifecycle per row,
  partial cancellation.
- **Assignment rows with an application-copied interval (no cascade FK)** — rejected: drift is possible; the cascade
  FK makes drift impossible.
- **Triggers to sync intervals** — rejected: a declarative FK does the same job with no procedural code.
- **Generic `bookables` table covering professionals and resources** — rejected: different lifecycles, rules and
  associations; a generic table would hide domain rules in type columns.
- **Locations as resources** — rejected: not a capacity-1 conflict authority.

## Consequences

- (+) PostgreSQL remains the only conflict authority, for any number of professionals and resources.
- (+) Reschedule and cancel stay single statements with atomic, multi-authority conflict checking.
- (−) Each appointment write touches more rows and GiST indexes (bounded: ≤ 5 participants, ≤ 3 resources).
- (−) The deferred FK and the cascade-target index are hand-written migration SQL (Drizzle DSL gap, as in F27).

## Deferred

Per-participant sub-intervals, capacity > 1, resource schedules, service→resource requirements, automatic resource
allocation, Locations (trigger above).
