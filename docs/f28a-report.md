# F28A Report — Appointment Evolution & Operational Extensions (decision spike)

## 1. Executive summary

F28A closes the architecture for the next evolution of Appointments after F27, with **no production code, no
migration, no schema change, no API/UI change, and no UL Platform change**. Six ADRs (045–050) freeze:

| Topic | Decision (one line) | ADR |
|---|---|---|
| Multi-service | `appointment_services` line table becomes the source of truth; F27 service columns kept as a line-1 mirror during expand → contract | 045 |
| Buffers | buffers on `professional_services` (ADR-040 D11), snapshotted on the appointment; stored `occupied_start_at/occupied_end_at` with an exact DB CHECK; the existing no-overlap constraint is redefined on the occupied interval (same name, strictly stronger) | 046 |
| Multi-professional | `appointment_professionals` (RESPONSIBLE/ASSISTING) with its own exclusion constraint; interval + status kept in sync **by the database** via an `ON UPDATE CASCADE` composite FK | 047 |
| Resources / locations | `resources` (capacity-1 physical assets) + `appointment_resources`, same cascade + exclusion pattern, `409 RESOURCE_CONFLICT`; **Locations are a different concept (not a conflict authority) and are deferred** with an explicit trigger; capacity > 1 deferred | 047 |
| NO_SHOW | terminal state from SCHEDULED only, after `start_at`, no upper window, keeps occupying (no constraint change), audited, metered, published | 048 |
| Idempotency | `idempotency_keys` row committed **in the same transaction** as the booking; replay of committed successes only; concurrent same-key requests serialized by the unique index; 24h TTL — explicitly distinct from conflict safety | 049 |
| Outbox / notifications | `outbox_events` written in the business transaction; lease-based in-process dispatcher publishing to the existing UL Platform `/events`; stable `data.eventId` for consumer dedupe; providers are Platform webhook subscribers, never called by Na Pista | 050 |

The central technical result: **PostgreSQL can remain the only conflict authority for every extension** (multiple
professionals, resources, buffers). This was **proven** on the project's own PostgreSQL 17.6 with a rolled-back probe
(§3.3), not assumed. Implementation is split into seven dependency-based slices (§12). **Status: F28A — COMPLETE.**

## 2. F27 invariants preserved

| F27 invariant | F28 outcome |
|---|---|
| Appointment belongs to one Organization | unchanged; every new table carries `organization_id` with composite FKs |
| Exactly one Customer | unchanged (no multi-customer decision; out of scope) |
| Exactly one Professional / one Service | **extended additively**: `appointments.professional_id` keeps meaning "responsible professional"; `service_id` kept as line-1 mirror until the gated contract step (ADR-045) — no F27 API field disappears during F28 |
| `[start_at, end_at)`, `timestamptz` | unchanged; buffers add a separate *occupied* interval, never alter the visible one |
| Duration frozen at booking | unchanged (`end − start`; per-line durations are snapshots too) |
| name/price/currency snapshots | unchanged; moved per line (currency stays per appointment) |
| Customer is not a Platform User; immutable | unchanged |
| ACTIVE Professional/Service for booking/reschedule | unchanged, applied to every participant and every service |
| F26 engine reused, no HTTP, no second availability source | unchanged — every extension calls `computeAvailability` with a different duration or once per participant |
| Availability advisory / write authoritative / exclusion constraint final | unchanged; strengthened with more constraints of the same kind |
| STAFF read-only; OWNER/ADMIN/MANAGER write | unchanged (new `resources.*` follows the same shape) |
| `catalog.enabled` | unchanged; no new Platform entitlement |
| Audit transactional; usage after commit | unchanged; outbox added *beside* audit in the same transaction |
| Tenant isolation HTTP + repository + DB | unchanged mechanisms applied to all new tables |

**The one explicit (not silent) change to an F27 artefact:** ADR-046 redefines `appointments_professional_no_overlap`
to use the occupied interval. Same name, same error mapping; since occupied ⊇ visible, it can never accept a pair the F27
definition rejected, and with zero buffers it is identical. ADR-044's mechanism is unchanged.

## 3. Current architecture (verified in code, not docs)

### 3.1 What exists (commit `db8a473`)

- `src/modules/appointments/`: `time.ts` (Intl conversions), `lifecycle.ts` (3 states), `booking.ts` (reuses
  `computeAvailability`), `snapshot.ts`, `repository.ts` (tenant-asserted, `FOR UPDATE`), `service.ts` (transaction
  boundary, `mapBookingWriteError`: 23P01 + 40P01 → APPOINTMENT_CONFLICT), `schemas.ts`, `routes.ts`.
- `src/db/schema/appointments.ts` + migrations `0007` (table) and `0008` (hand-written exclusion constraint, btree_gist).
- `professional_services` has **no** buffer columns; `appointments` has no `(organization_id, id)` unique index (nothing
  references it yet).
- Audit: `modules/audit/service.ts` (`recordAuditEvent(entry, tx)`, failures propagate → rollback).
- Usage: `src/platform/usage.ts` (`recordUsage`, `api_requests`, fail-open, called after commit).
- Permissions: `appointments.read/create/update` (STAFF read).
- Console: day view, create flow on `bookable-slots`, detail (reschedule/cancel/complete/notes), Professional/Customer
  "Marcações" sections, `lib/api/appointments.ts` (thin `callNaPista` wrappers), UX-only permission mirror.
- UL Platform: `POST /v1/organizations/:orgId/events` (`event.publish`, org-matched credential, `domain.action` regex);
  `publishEvent` creates a fresh `evt_<uuid>`/`occurredAt` **per call**, delivers once, no retry; seed scopes for
  NA_PISTA include `event.publish`, `usage.write`, `catalog.read/write`, `customer.read`.

### 3.2 Divergences between documents and code (code taken as fact)

1. The brief lists `src/modules/usage/*` — **does not exist**; usage lives in `src/platform/usage.ts`.
2. `docs/events.md` §3 proposes an `OutboxMessage` — **never implemented**; no event is published by Na Pista today.
3. `docs/events.md` §4 lists `appointment.created` with `startsAt` and no `rescheduled`/`no_show` — superseded for
   appointments by ADR-050's catalog (to be reflected in `events.md` when F28D is implemented).
4. `docs/domain-model.md` §5 lists `TenantSettings` — the real table is `organization_settings` (ADR-040).

### 3.3 PostgreSQL feasibility probe (rolled back; temp tables only; nothing persisted)

Design under test: parent table with stored occupied bounds + buffer CHECK + exclusion constraint + cascade-target
unique key; child assignment table with `FOREIGN KEY (org, appointment_id, occ_start, occ_end, status) … ON UPDATE
CASCADE` and its own exclusion constraint.

| Step | Result |
|---|---|
| Insert appointment with 15-min after-buffer (occupied 10:00–11:15) + 2 participants | OK |
| CHECK `extract(epoch from (start_at − occ_start)) = before*60 AND …` rejects wrong occupied bounds | `23514` — CHECK accepted by PG and enforced |
| Same professional at 11:00 (inside the buffer) | `23P01` on the appointment constraint |
| 11:15 (adjacent to the occupied end) with the assistant from A | OK |
| Another appointment making A's assistant overlap | `23P01` on the **participants** constraint |
| Reschedule A +60 min, which would clash an assistant | `23P01` — the cascade re-checked child rows; whole statement rolled back, participants unmoved |
| Cancel C → cascade | child statuses became `CANCELED,CANCELED` |
| Reschedule A again (now free) | OK — participants followed the new occupied interval |
| Direct divergent write on a participant row | `23503` — impossible to desync |

## 4. Multi-service decision — ADR-045

- **Current:** one `service_id` + snapshots on `appointments`; duration `end − start`.
- **Problem:** multi-service visits are two independent appointments today.
- **Options:** breaking replacement; primary + extras; linked appointments; JSON array; **line table (chosen)**.
- **Chosen:** `appointment_services` (position, per-line snapshots incl. duration), 1..10 lines, service unique per
  appointment, currency per appointment, total price computed on read (`null` if any line unpriced), Σ durations =
  visible interval, lines immutable after booking.
- **Why:** one visit = one lifecycle = one conflict row; F27 conflict authority untouched; rows-not-arrays convention.
- **Migration:** expand (table + backfill 1 line/appointment + line-1 mirror writes) → gated contract (drop mirror
  columns). Backward compatible through expand; rollback window until the first multi-line appointment + contract.
- **API:** `serviceIds[]` or F27 `serviceId`; `services[]`, `totalPrice`; deprecated single-service fields until contract.
- **UI:** add/reorder services, per-line and total price.
- **Tenant/authz/audit/usage:** composite FKs; unchanged permissions; `serviceIds` in audit metadata; one usage unit per booking.
- **Availability / conflict:** engine called with Σ duration; conflict unchanged.
- **Tests:** backfill, mirror consistency, association for every service, archived service in any line, Σ rule.
- **Deferred:** per-line professionals, gaps, discounts, duplicate services.

## 5. Multi-professional decision — ADR-047

- **Current:** one professional; one conflict constraint on `appointments`.
- **Problem:** simultaneous multi-professional bookings need per-professional conflict protection across roles.
- **Options:** app-level SELECT (rejected: TOCTOU); linked appointments; copied interval without sync; triggers;
  **assignment table + cascade FK + exclusion (chosen)**.
- **Chosen:** `appointment_professionals` for **all** participants (one RESPONSIBLE, others ASSISTING, 1..5), shared
  occupied interval kept in sync by `ON UPDATE CASCADE`, own exclusion constraint; `appointments.professional_id`
  stays = responsible, guaranteed by a deferred composite FK; F27 constraint kept (subset, harmless).
- **Why:** PostgreSQL stays the conflict authority; reschedule/cancel remain single atomic statements (probe §3.3).
- **Archived participant:** existing untouched; reschedule requires all ACTIVE — replace the participant in the same PATCH.
- **Availability:** unchanged engine, evaluated per participant; bookable slots = intersection.
- **Migration:** additive table + backfill (one RESPONSIBLE row per appointment) + deferred FK (`NOT VALID` → `VALIDATE`).
- **API:** `professionalIds[]` (first = responsible) or F27 `professionalId`; `professionals[]` in the representation;
  filter matches any participant; clashes → `APPOINTMENT_CONFLICT`.
- **Tests:** cross-role clashes, cascade atomicity, cancel releases all, concurrent bookings sharing only an assistant.

## 6. Buffers decision — ADR-046

- **Current:** none; visible interval = conflict interval.
- **Problem:** preparation/cleanup must block time without changing the booked duration.
- **Options:** Service/Professional/Organization/combination sources; expression index (impossible: STABLE);
  second constraint; availability-only buffers (rejected: not authoritative); **pair-level source + stored occupied
  bounds + CHECK + redefined constraint (chosen)**.
- **Chosen:** `professional_services.buffer_before/after_minutes` (0..240); resolved from the responsible
  professional's first/last service; snapshotted on the appointment; preserved on reschedule; `durationMinutes`
  unchanged; occupied interval must fit a working interval (engine called with before + Σ + after).
- **Migration:** one migration: columns (defaults 0), backfill occupied = visible, CHECK, constraint swap (validates
  trivially); reversible.
- **Consequence:** before-buffers shift visible starts off the round grid (documented).

## 7. Resources / locations decision — ADR-047

- **Resource** = capacity-1 bookable physical asset: `resources` catalog (`resources.*` permissions) + explicit 0..3
  `appointment_resources` per appointment, same cascade + exclusion pattern, `409 RESOURCE_CONFLICT`. No resource
  schedules, service requirements or auto-allocation (deferred). **Capacity > 1 deferred** (needs counted admission).
- **Location** = where the organization operates; **not** a conflict authority, so not a resource. Its real impact is
  on Scheduling and timezone (ADR-039/040 extension points). **Deferred**, model recorded, trigger = a tenant with more
  than one site.
- A second (and third) conflict authority is added **beside** the professional one — separate tables, separate
  constraints, separate error codes; the existing professional constraint is never modified by ADR-047.

## 8. NO_SHOW decision — ADR-048

Terminal, from SCHEDULED only, `POST …/no-show`, after `start_at` (server clock; `409 APPOINTMENT_NO_SHOW_TOO_EARLY`),
no upper window, `appointments.update`, keeps occupying (predicate unchanged), `no_show_at` + CHECK, status CHECK
extended, audit `appointment.no_show`, usage after commit, event `appointment.no_show`, no backfill of interim
cancellations. Clients must accept a fourth status value.

## 9. Idempotency decision — ADR-049

**Conflict safety** (never two bookings) is F27's constraint; **idempotency** (a retry returns the first result) is new.
`idempotency_keys (organization_id, operation, key)` PK; actor + canonical SHA-256 request hash; the key row is inserted
as the first statement **of the booking transaction** and committed with it: committed success → replay (`201`, current
resource, `Idempotency-Replayed: true`); any failure rolls the key back (retry re-executes); different payload or actor →
`409 IDEMPOTENCY_KEY_REUSED`; concurrent same-key requests serialize on the unique index (first commits → second
replays; first rolls back → second executes); 24h TTL; optional header (F27 behaviour without it); `POST /appointments`
only; no response-body snapshot (no JSONB, no PII duplication); no audit/usage on replay.

## 10. Outbox / notification decision — ADR-050

`outbox_events` written with `enqueueEvent(tx)` beside the audit row; catalog `appointment.created/rescheduled/
canceled/completed/no_show` (not `updated`; `confirmed` deferred); minimal payload (ids/state, no PII), `eventVersion 1`
with array-shaped `serviceIds/professionalIds` from day one; in-process dispatcher with lease-based claim
(`FOR UPDATE SKIP LOCKED`, HTTP outside transactions), per-aggregate FIFO, exponential backoff, 12 attempts → DEAD,
non-retryable 4xx → DEAD; consumers dedupe by `data.eventId` (the Platform's envelope id changes per publish — verified);
retention 7 days delivered / 30 days dead; housekeeping also purges expired idempotency keys. Notifications (e-mail,
WhatsApp/Qualé a Dica?!, others) are Platform webhook subscribers — Na Pista never calls a provider.

## 11. Dependency graph (as concluded)

```
F27 (done)
 │
 ├──► F28B NO_SHOW ─────────────────────────────┐ (adds one event type; soft)
 │                                               ▼
 ├──► F28D Outbox + event publishing ──► notifications = Platform webhook subscribers
 │         (independent; housekeeping purges           (e-mail, WhatsApp / Qualé a Dica?!, tenant systems)
 │          idempotency keys — soft link to F28C)       — outside Na Pista
 │
 ├──► F28C Idempotency-Key (independent)
 │
 ├──► F28E Multi-service (expand) ──────► F28E′ contract (drop mirror columns; gated, later)
 │
 └──► F28F Occupied interval + buffers
           │   (HARD: introduces occupied_* columns that every
           │    additional conflict authority cascades from)
           ├──► F28G Participating professionals
           └──► F28H Resources
                                         Locations, capacity > 1: deferred (explicit triggers)
```

Hard dependencies: G and H require F (cascade target + occupied columns; building them on `start_at/end_at` first would
force redefining two more exclusion constraints later). Everything else is independent: E and F compose (buffer
resolution uses first/last line, identical with one line; availability duration = before + Σ + after in either order),
B/C/D touch no shared schema. Soft links (not ordering constraints): B adds a catalog entry to D; D's housekeeping purges
C's expired keys (C works without it — expired keys are treated as absent).

## 12. Proposed F28 implementation boundaries

A single F28 is rejected: it would combine a constraint redefinition (F), cascade/deferred-FK DDL (G/H), a background
worker (D) and API contract extensions (B/C/E) in one change — unreviewable risk. Slices, each independently
releasable and testable:

| Slice | Content | ADR | Depends on | Main risk |
|---|---|---|---|---|
| F28B | NO_SHOW | 048 | F27 | low (CHECK swap, new status value for clients) |
| F28C | Idempotency-Key for create | 049 | F27 | medium (transaction ordering, hashing) |
| F28D | Outbox + dispatcher + event catalog | 050 | F27 | medium (background loop, at-least-once) |
| F28E | Multi-service (expand) | 045 | F27 | medium (backfill, mirror consistency) |
| F28E′ | Contract: drop mirror columns | 045 | F28E + consumers migrated | gated, irreversible step |
| F28F | Occupied interval + buffers | 046 | F27 | high (constraint redefinition) |
| F28G | Participating professionals | 047 | F28F | high (cascade + deferred FK) |
| F28H | Resources catalog + assignment | 047 | F28F | medium (new catalog + cascade) |

No subjective priority is implied among independent slices; order them by product need.

## 13. Migration / evolution strategy

- Every slice is **additive** (new tables/columns with defaults, backfills inside the migration) except two explicitly
  justified steps: ADR-046's constraint swap (same name, strictly stronger, reversible) and ADR-045's contract step
  (gated, the only irreversible change, deliberately separated from expand).
- Hand-written SQL (`drizzle-kit generate --custom`) for everything Drizzle's DSL cannot express: exclusion constraints,
  cascade-target unique keys with `ON UPDATE CASCADE`, deferred FKs, the occupied CHECK if expressed with `extract`.
  Each gets a `pg_constraint` regression test (the F27 pattern).
- Backfills: lines (E), occupied = visible (F), RESPONSIBLE participants (G) — all deterministic from existing columns.
- API evolution: new fields added, old fields kept until a documented contract step; new status value (NO_SHOW) is the
  only change clients must handle.

## 14. Deferred decisions (with triggers)

| Deferred | Trigger |
|---|---|
| Locations (+ per-location schedule/timezone) | a tenant with more than one physical site |
| Resource capacity > 1 (classes, shared rooms) | a service sold per seat |
| Resource schedules / service→resource requirements / auto-allocation | a tenant whose resources have their own hours or mandatory pairing |
| Per-participant sub-intervals / per-line professionals | a service where assistants join only part of a visit |
| Inter-service buffers, organization-default buffers | evidence that pair-level buffers are insufficient |
| CONFIRMED / `appointment.confirmed` | a confirmation flow (reminder → customer confirms) |
| Completion / NO_SHOW undo | operational evidence of frequent mistaken marks |
| Idempotency for PATCH/cancel/complete | a public or third-party integration calling them |
| Usage via outbox | loss of usage writes observed/unacceptable |
| Operator UI for DEAD events | first production dispatcher run |
| Dropping the F27 appointment-level constraint after F28G | never required; optional cleanup |

None of these blocks any F28 slice.

## 15. Risks

| Risk | Mitigation |
|---|---|
| Constraint redefinition (F28F) on a large table takes a lock while validating | run in a maintenance window; data volume today is small; definition identical for zero buffers |
| Hand-written DDL drifting from Drizzle snapshots | `pg_constraint` tests per constraint; `drizzle-kit push` never used |
| Cascade updates touching many child rows | bounded cardinalities (≤ 5 participants, ≤ 3 resources) |
| 40P01 deadlocks become more frequent with more constraints per write | a deadlock carries no constraint name, so it cannot say *which* authority was contended: it stays mapped to the generic `APPOINTMENT_CONFLICT` ("the booking lost a race; refresh"), while `23P01` maps precisely (professional → `APPOINTMENT_CONFLICT`, resource → `RESOURCE_CONFLICT`); stress tests per slice |
| Outbox consumers assuming exactly-once/ordered delivery | documented contract (dedupe by `data.eventId`, re-fetch state) |
| Platform webhooks: single attempt, no dedupe | external; recorded for UL Platform; outbox retries cover Na Pista → Platform only |
| In-memory service credential registry (F20 limitation) blocks the dispatcher after restart | events stay PENDING (retry), never lost; credential persistence remains a known limitation |
| Clients breaking on `NO_SHOW` | documented contract extension; Console updated in the same slice |

## 16. Test strategy (per slice, same discipline as F27)

Unit (pure rules: transitions, Σ duration, occupied computation, hashing), integration on real PostgreSQL (constraints,
backfills, cascades, rollback atomicity, tenant FKs), **real concurrency** (`Promise.allSettled` over separate
connections + the `pg_stat_activity` blocking proof where a new waiting mechanism appears: same-key idempotency,
participant/resource races, dispatcher `SKIP LOCKED`), E2E over real HTTP + Platform (including a real webhook receiver
for F28D), Console component tests, full F20–F28 regression with re-provisioned fixtures before each slice completes.

## 17. UL Platform impact

**None.** Outbox uses the existing `/events` endpoint and `event.publish` scope; resources/NO_SHOW/idempotency are Na
Pista domain; `catalog.enabled` still gates everything. `btree_gist` is already installed (F27). Recorded Platform-side
observations (not F28 blockers): webhook delivery is single-attempt and non-deduplicated.

## 18. Console impact (future slices; nothing changed now)

B: "Não compareceu" action, badge, filter. C: generate/reuse an `Idempotency-Key` per submit; navigate on replay.
D: none. E: service list in create flow, per-line/total price in review and detail. F: buffer inputs on
professional–service associations; buffer display in detail. G: participant picker (responsible + assistants), slot
intersection. H: resources catalog page (`resources.*`), resource picker in create/reschedule, `RESOURCE_CONFLICT`
message.

## 19. Final implementation readiness checklist

- [x] Cardinalities fixed (lines 1..10, participants 1..5 with exactly one responsible, resources 0..3, capacity 1).
- [x] Lifecycles fixed (NO_SHOW terminal; lines/participants/resources have none of their own; changes via booking rules).
- [x] Conflict authority fixed (PostgreSQL exclusion constraints only; cascade keeps copies in sync; proven §3.3).
- [x] Idempotency semantics fixed (scope, hash, transaction boundary, replay, mismatch, concurrency, TTL).
- [x] Outbox semantics fixed (table, transaction boundary, catalog, payload, dispatcher, retries, ordering, retention, consumer contract).
- [x] Tenant boundaries fixed (org in every PK/FK, composite FKs, tenant-scoped replay and dispatch).
- [x] Migration strategy fixed per slice (additive; two explicit exceptions justified).
- [x] Error codes fixed (`RESOURCE_CONFLICT`, `APPOINTMENT_NO_SHOW_TOO_EARLY`, `IDEMPOTENCY_KEY_REUSED`; others reused).
- [x] Permissions fixed (`appointments.*` unchanged; `resources.*` new, same role shape); entitlement unchanged.
- [x] Slices and hard dependencies fixed (§11–§12).
- [x] No F27 decision silently changed (§2).
- [x] No production code, migration, schema, API, UI or Platform change made; only documents (`docs/adr/ADR-045…050`,
      `docs/adr/README.md`, this report). The feasibility probe ran from the session scratchpad inside a rolled-back
      transaction on temp tables.

**Open architecture decisions: none.** Deferred items (§14) have explicit triggers and block no slice.
