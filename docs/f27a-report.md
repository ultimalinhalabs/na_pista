# F27A Report — Appointment & Booking Domain Decision Spike

## 1. Executive summary

F27A freezes the Appointment/Booking domain for F27. Decisions are recorded in **ADR-042** (domain model),
**ADR-043** (lifecycle/state machine) and **ADR-044** (concurrency and conflict enforcement). In short:

- An Appointment is **one staff-committed reservation of one Professional, for one Service, for one Na Pista
  Customer, over one absolute `[start_at, end_at)` interval** — all three references required, all composite
  tenant-safe FKs.
- History is protected by snapshotting **service name, price and currency**; duration is fixed as
  `end_at - start_at` (not re-derived from the live Service, not stored twice).
- Three states: **`SCHEDULED` (created directly) → `COMPLETED` | `CANCELED`**, both terminal. No DRAFT,
  CONFIRMED or NO_SHOW in F27 (reasoned, with additive paths).
- **Conflict enforcement: a PostgreSQL exclusion constraint** on `(organization_id =, professional_id =,
  tstzrange(start_at, end_at, '[)') &&) WHERE status <> 'CANCELED'`, using `btree_gist`. Feasibility was
  **demonstrated against the project's real database** (PostgreSQL 17.6) in a fully rolled-back probe,
  covering insert, partial overlap, adjacency, cross-tenant, cancellation release, reschedule-UPDATE and
  un-cancel.
- Booking is **strictly inside F26 availability** (start must be one of F26's `serviceStartTimes`); the
  operational override path is the existing Scheduling exception.
- Permissions `appointments.read/create/update`; entitlement `catalog.enabled`; audit
  `appointment.created/rescheduled/updated/canceled/completed`; usage via `api_requests`.
- **UL Platform impact: none.** No production code, migration, route or UI was created.

**Status: F27A — COMPLETE.** No architecture-blocking decision remains open (§52 lists non-blocking product
questions).

## 2. Repository inspection

Git state was inspected **before** any change: `na-pista` (main, `b48153f`, clean), `na-pista-console`
(main, `269b6ff`, clean), `ul-platform` (master, `2cf614f`, clean).

Inspected directly in **na-pista**: ADR-029/030/031/032/034/035/037/038/039/040/041; `docs/f26-report.md`,
`docs/f26a-report.md` (headings/boundary), `docs/domain-model.md` SD-3/4/5, `docs/decisions.md` OD-16;
schema `_helpers`, `customers`, `services`, `professionals`, `professionalServices`,
`professionalScheduleExceptions`, `organizationSettings`, `orders` (+ `order_items`); modules
`scheduling/{availability,service,routes,schemas}.ts`, `orders/{service,repository,routes,schemas}.ts`,
repository signatures of `customers`/`professionals`/`services`/`scheduling`/`organizationSettings`;
`shared/errors.ts`, `shared/response.ts`, `middleware/{errorHandler,requireAuthorized,requireCapability}.ts`,
`authorization/permissions.ts`, `tenancy/actor.ts`, `audit/service.ts`, `platform/usage.ts`, `db/index.ts`
(pool `max: 5`), `drizzle.config.ts`, migrations list + `0006`, concurrency tests in
`tests/integration/{inventory,orders}.test.ts`, test layout (unit/integration/e2e + helpers).

**na-pista-console**: `package.json` (Next 15, React 19, Vitest), file tree, `lib/api/{scheduling,errors}.ts`,
`lib/permissions.ts` (UX-only mirror), `lib/format.ts`, `app/o/[organizationId]/layout.tsx` (membership
gate, nav), order detail page conventions (`useState`/`useEffect`, `ApiError`, request-id display),
Professional detail page (591 lines; Horário/Excepções/Disponibilidade tabs per F26 report).

**ul-platform** (verification only): seed `data.ts` — NA_PISTA service scopes include `catalog.read`/
`catalog.write`; meters allow-listed for NA_PISTA include `api_requests`; `catalog.enabled` seeded for
STARTER/BUSINESS. No change needed or made.

**Database** (read-only + rolled-back probe, §32): PostgreSQL 17.6; installed extensions `pg_stat_statements`,
`pgcrypto`, `uuid-ossp` (in `extensions`), `supabase_vault`; `btree_gist` 1.7 **available, not installed**.
After the probe: still not installed (rollback verified).

**Drizzle**: `drizzle-orm` 0.45 `pg-core` has no `EXCLUDE` builder and no range type; `drizzle-kit` 0.31
supports `generate --custom`; Drizzle transactions accept `isolationLevel`.

## 3. F26 integration contract

Real F26 contract (from code, not from F26A's conceptual text):

| Aspect | Actual behaviour |
|---|---|
| Endpoint | `GET /v1/organizations/:organizationId/professionals/:professionalId/availability?from&to[&serviceId]` — `scheduling.read` / scope `catalog.read`, gated by `catalog.enabled` |
| Input | `from`, `to`: `"YYYY-MM-DD"` local dates, inclusive, `to >= from`, ≤ 92 days; `serviceId` optional UUID; `.strict()` |
| Output | `{ timezone, days: [{ date, workingIntervals: [{start,end}], serviceStartTimes? }] }` — all **local wall-clock** strings (`"HH:mm"`) |
| Timezone | required (`409 TIMEZONE_NOT_CONFIGURED`), **only echoed** — the pure engine does no local↔UTC conversion at all |
| Duration | live `Service.durationMinutes` when `serviceId` given |
| Start times | every 15 min (`BOOKING_INCREMENT_MINUTES`) **anchored at each interval's start**, only where `start + duration <= interval.end`; never across two intervals (adjacent intervals are not merged) |
| Exceptions | any exception row for a date replaces the weekly rule entirely; closed-marker → empty |
| Archived Professional | `409 PROFESSIONAL_ARCHIVED` |
| Archived Service | `409 SERVICE_ARCHIVED`; missing or not associated → `404 NOT_FOUND` (indistinguishable) |
| Tenant | every read through tenant-scoped repositories; foreign ids → 404 |
| Appointments | not subtracted (none exist) — "working availability", advisory |

**F26/F27 boundary for F27:**
- F27 **reuses** `computeAvailability` (pure) and the scheduling repositories (`listScheduleRules`,
  `listScheduleExceptionsInRange`, both accept a transaction executor), plus `getAssociation`, `getService`,
  `getProfessional`, `getCustomer`, `getTimezoneOrThrow`.
- F27 does **not** call the F26 HTTP endpoint and does **not** call `getAvailabilityOrThrow`.
- F27 **adds** (inside the appointments module, not in Scheduling): UTC→local conversion (Intl), local→UTC
  conversion for slot instants (ADR-040 DST contract), and the subtraction of occupying appointments to form
  **bookable** slots (ADR-040: bookable availability is F27's).
- **No change to any F26 file's behaviour.** The F26 endpoint keeps returning working availability only.

## 4. Appointment domain definition

"An actual booking/reservation of a Service with a Professional for a Customer at a specific time" is
confirmed, sharpened to: **one staff-committed reservation of one Professional's time, for one Service, for
one Na Pista business Customer, over one absolute half-open interval** (ADR-042). Appointment owns booking
state (status, times, snapshots, cancellation/completion facts). Scheduling owns working hours. Availability
is a computed input. Service/Professional/`professional_services` are read, never written.

## 5. Customer relationship

- **Required** (`customer_id NOT NULL`), composite FK `(organization_id, customer_id) → customers
  (organization_id, id)` (target unique index `customers_org_id_unique` already exists, F23).
- Na Pista **business Customer** (ADR-024/025) — never a UL Platform User/customer.
- No anonymous/guest appointments; staff record walk-ins by creating a minimal Customer (name only is valid).
  "Blocked time without a customer" is a Scheduling exception, not an Appointment.
- Archived Customer: existing appointments remain; new/reschedule → `409 CUSTOMER_ARCHIVED`; cancel/complete
  allowed.
- `customer_id` is **immutable** after creation (different customer = different booking).
- **No customer snapshot**: the Customer row is never deleted and name/phone edits are corrections that should
  propagate. Cross-tenant ids → `404` (tenant-scoped lookup) and structurally impossible via the FK.

## 6. Professional relationship

- **Required**, composite FK to `professionals_org_id_unique` (exists, F25).
- Must be `ACTIVE` at creation and as the **target** of a reschedule; `409 PROFESSIONAL_ARCHIVED` otherwise.
- Archived Professional keeps all historical appointments (no cascade, no delete, no auto-cancel); existing
  `SCHEDULED` ones can still be canceled/completed. Reactivation changes nothing historically.
- Reschedule may change `professional_id` (the new one must be ACTIVE and associated with the booked Service).
- No name snapshot (identity is the fact; see ADR-042).

## 7. Service relationship

- **Required**, composite FK to `services_org_id_unique` (exists, F25). One Service per Appointment.
- Must be `ACTIVE` and associated with the Professional via `professional_services` at creation and on
  reschedule.
- `service_id` immutable after creation.

## 8. Service snapshot decision

**Option B — reference + targeted snapshot** (ADR-042): `service_id` (FK) + `service_name`, `service_price`,
`currency`; duration fixed as `end_at - start_at`. Option A (reference only) violates ADR-034; option C (full
copy) copies non-booking facts. Snapshots are captured **once, at creation**, from the Service row read inside
the creating transaction; never re-captured on reschedule; never updated by Service edits.

## 9. Duration decision

- Creation: `end_at = start_at + Service.durationMinutes` (absolute minutes), computed server-side from the live
  Service in the creating transaction. The client never supplies `end_at` or a duration in F27.
- Historical representation: `end_at - start_at`; exposed as derived `durationMinutes` in the API.
- Update/reschedule: duration **preserved** from the appointment itself (`new end = new start + (end_at -
  start_at)`), never re-read from the Service. Changing `Service.durationMinutes` never changes any existing
  appointment.
- Custom per-appointment duration: deferred (additive optional field on create, validated like any other).

## 10. Money/price snapshot decision

- **Snapshot required** (ADR-034 already mandated it; historical integrity of "what was agreed").
- `service_price numeric(14,2) NULL` — ADR-029 representation (decimal string on the wire, never float);
  `NULL` when the Service was unpriced at booking; `0` means free. Unpriced Services **can** be booked
  (reservation ≠ sale — unlike `order_items`, which require a price).
- `currency text NOT NULL`, `CHECK (currency ~ '^[A-Z]{3}$')`, from the same single operating currency Orders
  use (`DEFAULT_CURRENCY = "AOA"`, currently private to `orders/service.ts`; F27 moves it to a shared module so
  there is exactly one source — a two-line, behaviour-preserving extraction).
- Captured at creation; not on reschedule. No payment status, invoice, transaction or ledger field.
- Future billing obtains the agreed amount from `appointments.service_price/currency`; payment execution
  belongs to Orders or Micha Express through explicit APIs (§44).

## 11. Time representation

- `start_at`, `end_at`: `timestamptz` (ADR-040), absolute instants. API: ISO-8601 with `Z` or explicit offset
  on input (`z.string().datetime({ offset: true })`), UTC `Z` on output — the Order convention.
- Input must have zero seconds and milliseconds (400 otherwise).
- Local interpretation: organization timezone from `organization_settings` (required; no fallback).
- UTC→local (write validation, display): `Intl.DateTimeFormat` with `timeZone` — no new dependency.
- Local→UTC (bookable slots only): small helper implementing ADR-040's DST contract (gap → skip slot;
  overlap → earlier instant); unit-tested with a DST zone (e.g. `Europe/Lisbon`) since F27 is the first phase
  that genuinely exercises DST.
- Known accepted edge: on a fall-back day, an appointment's wall-clock end may differ from `local start +
  duration` by the DST shift; the absolute duration is always exact. Zero impact for `Africa/Luanda` (no DST).

## 12. Appointment states

`SCHEDULED` (active, occupies), `COMPLETED` (terminal, occupies), `CANCELED` (terminal, releases). Rationale,
per-state meaning, and rejected states (DRAFT, CONFIRMED, NO_SHOW, REQUESTED) in ADR-043. Creation means
**booked and committed** (`SCHEDULED`), with no approval step.

## 13. State transition matrix

| Current | Action | Next | Allowed | Occupies after | Notes |
|---|---|---|---|---|---|
| — | create | SCHEDULED | ✅ | yes | full validation |
| SCHEDULED | reschedule | SCHEDULED | ✅ | yes | full validation on new time/professional |
| SCHEDULED | edit notes | SCHEDULED | ✅ | yes | |
| SCHEDULED | cancel | CANCELED | ✅ | no | any time; optional reason |
| SCHEDULED | complete | COMPLETED | ✅ if `now >= start_at` | yes | |
| SCHEDULED | confirm | — | ❌ | | no such action |
| CANCELED | any (reschedule/edit/complete/cancel/un-cancel) | — | ❌ 409 | | rebook = new appointment |
| COMPLETED | any (cancel/reschedule/edit/complete) | — | ❌ 409 | | no undo in F27 |

Who: create → `appointments.create`; every other mutation → `appointments.update` (§36).

## 14. Booking invariant

> For any organization *O* and Professional *P*, no two Appointments of *O*/*P* with `status <> 'CANCELED'`
> have overlapping `[start_at, end_at)` intervals.

Enforced by the database (ADR-044), independent of any application code path.

## 15. Conflict definition

`overlap(A, B) ⇔ A.start_at < B.end_at ∧ B.start_at < A.end_at` on half-open `[start, end)` intervals.
Adjacent intervals (10:00–11:00, 11:00–12:00) do **not** overlap — both allowed. Identical intervals overlap.
Zero-length intervals are impossible (`CHECK end_at > start_at`). PostgreSQL: `tstzrange(start_at, end_at,
'[)') && tstzrange(...)` — verified (§32 rows A–D). Same rule F26 uses for working intervals.

## 16. Availability vs booking boundary

- **Availability** (F26 working availability; F27 bookable slots): "*can this Professional theoretically
  perform this Service at this time?*" — **advisory projection**, stale on arrival.
- **Appointment write**: "*can this booking be committed now without conflict?*" — **authoritative**, decided
  by the exclusion constraint in the write transaction.
- The write path re-validates availability itself (never trusts the client or a prior read) **and** relies on
  the constraint for conflicts. A slot shown as free can legitimately yield `409 APPOINTMENT_CONFLICT`.

## 17. Booking outside availability

**Strict in F27**: create/reschedule must start at one of F26's `serviceStartTimes` for that local date
(`409 APPOINTMENT_OUTSIDE_AVAILABILITY`). The gym-manager case ("occasionally outside normal hours") is served
by the existing Scheduling exception: a manager (who already holds `scheduling.create`) opens the extra
interval for that date, then books — keeping Scheduling the single source of working time, with its own audit
event. Caveat: an exception replaces the whole day (ADR-039 D4), so the normal hours must be re-entered with
the extra interval; the F27 Console "outside availability" error state links to the exceptions tab, and the
exception form should prefill that day's weekly intervals (small F27 UX item).

## 18. Override decision

**No override** in F27: no flag, no permission, no stored reason (ADR-044). Rationale: the smallest defensible
model; an override would let Appointments silently diverge from Scheduling and would need its own permission
tier, audit semantics and UI. Additive path if a real need appears: `appointments.override_availability`
permission + `availability_override boolean` + `override_reason text` on the row, audited — the conflict
constraint is unaffected either way (overrides can never bypass double-booking protection).

## 19. Archived entity behavior

See ADR-042 table. Summary: archived Customer/Professional/Service or removed association → no new booking,
no reschedule; existing appointments untouched and still cancelable/completable; archival never cascades.

## 20. Rescheduling semantics

- In-place `PATCH /appointments/:id` with `startAt` and/or `professionalId` (plus optionally `notes`); only
  from `SCHEDULED`.
- Row locked (`FOR UPDATE`), then the same validation as create (ACTIVE entities, association of the target
  Professional with the booked Service, timezone, future/horizon, F26 start-time check with the **preserved**
  duration), then `UPDATE`; the exclusion constraint guarantees no overlap (§47).
- Immutable: `customerId`, `serviceId`, snapshots, duration. Changing those = cancel + create.
- A PATCH that changes nothing time-related (notes only) skips availability validation.
- Audit `appointment.rescheduled` with `{from: {startAt, professionalId}, to: {...}}`.

## 21. Cancellation semantics

`SCHEDULED → CANCELED` via `POST /appointments/:id/cancel { reason? }` (≤ 500 chars); sets `canceled_at`;
releases the interval immediately; irreversible; canceled appointments cannot be edited; permission
`appointments.update`; actor in audit. No cancellation window, fee, policy or notification in F27.

## 22. Completion semantics

`SCHEDULED → COMPLETED` via `POST /appointments/:id/complete`; allowed once `now >= start_at` (not required to
wait for `end_at`); sets `completed_at`; terminal; not editable; keeps occupying its interval; permission
`appointments.update`. No billing/payment/stock side effect.

## 23. No-show decision

**Deferred** (ADR-043). Interim: cancel with a reason. Additive path: terminal `NO_SHOW` from `SCHEDULED` after
`start_at`; automatically occupying under the `<> 'CANCELED'` predicate — no constraint change.

## 24. Multi-service decision

**One Appointment → one Service** (ADR-035/041 D19). A multi-service booking in F27 = consecutive
appointments (adjacency is allowed). Additive path: `appointment_services` line table carrying the snapshot
columns per line; the appointment's interval becomes the sum of line durations; the constraint is unchanged.

## 25. Multi-professional decision

**One Appointment → one Professional** (ADR-041 D18). Additive path: `appointment_professionals` join with
its own exclusion constraint per `(organization_id, professional_id, range)` on the join rows (the range
denormalized onto them), leaving single-professional rows untouched.

## 26. Recurrence decision

**Deferred.** Scheduling recurrence (a working-hours policy) ≠ Appointment recurrence (a series of distinct
commitments, each needing its own availability check and conflict outcome — partial-series failure semantics,
series edits, exceptions). No F27 consumer. Additive path: an `appointment_series` table referenced by
nullable `series_id`; each occurrence remains an ordinary Appointment protected by the same constraint.

## 27. Self-booking boundary

F27 is **staff-managed only**. The same domain service, states and constraint serve future self-booking;
what is added later lives around it: public/lightly-authenticated bookable-slots read with rate limiting,
Customer resolution (Platform identity → Na Pista Customer link, or guest → new Customer) — never a Platform
User used as the Customer record — `Idempotency-Key`, lead-time and cancellation-window policy, possibly
`confirmed_at`, and anti-abuse limits. Self-booking must call the domain service, never write the table
directly; the constraint makes bypassing conflict protection impossible even if it did.

## 28. Idempotency decision

**No `Idempotency-Key` in F27**, reasoned (ADR-044): a duplicate `POST` is the same Professional + interval
and is rejected by the constraint (`409 APPOINTMENT_CONFLICT`), so double-booking by retry/double-click is
impossible. Residual risk: a retry after a lost response shows "conflict" — Console refreshes on `409`.
Transitions are idempotent by state + row lock. Future: `Idempotency-Key` for public/integration callers.

## 29. Database model

| Column | Type | Null | Reason |
|---|---|---|---|
| `id` | uuid PK default random | no | codebase convention |
| `organization_id` | uuid | no | tenant; leading column of every index/FK |
| `customer_id` | uuid | no | who is attended (§5) |
| `professional_id` | uuid | no | who performs (§6); part of conflict key |
| `service_id` | uuid | no | what is booked (§7) |
| `start_at` | timestamptz | no | absolute start (§11) |
| `end_at` | timestamptz | no | absolute end; needed by the range constraint; encodes duration (§9) |
| `status` | text | no, default `SCHEDULED` | lifecycle (§12) |
| `service_name` | text | no | snapshot (§8) |
| `service_price` | numeric(14,2) | yes | snapshot; NULL = unpriced (§10) |
| `currency` | text | no | snapshot (§10) |
| `notes` | text (≤ 2000, Zod) | yes | one internal staff note; no customer-visible notes (no customer surface), no metadata JSON |
| `cancellation_reason` | text (≤ 500, Zod) | yes | operational context for a cancellation |
| `canceled_at` | timestamptz | yes | when it was canceled (list/detail display, reporting) |
| `completed_at` | timestamptz | yes | when it was marked done |
| `created_at`, `updated_at` | timestamptz | no | `timestamps` helper |

## 30. Database constraints

| Invariant | Where |
|---|---|
| Tenant-safe Customer/Professional/Service | composite FKs `(organization_id, x_id)` → existing `*_org_id_unique` indexes |
| No overlap for occupying appointments | **exclusion constraint** `appointments_professional_no_overlap` (custom SQL migration) |
| `end_at > start_at` | `CHECK appointments_end_after_start` |
| valid status | `CHECK appointments_status_valid` |
| `canceled_at` ⇔ CANCELED; `completed_at` ⇔ COMPLETED; reason only if CANCELED | three `CHECK`s |
| `service_price >= 0` when present; currency shape | `CHECK`s (Order/Service precedent) |
| Transition legality, ACTIVE/association, availability, future/horizon, minute alignment | application (domain service + pure functions), inside the transaction |
| Indexes | `appointments_org_start_idx (organization_id, start_at)` — date-range list; `appointments_org_professional_start_idx (organization_id, professional_id, start_at)` — list incl. canceled; `appointments_org_customer_start_idx (organization_id, customer_id, start_at)` — customer history; the constraint's GiST index — occupying-range lookup |

No `(organization_id, id)` unique index yet — nothing references appointments; added when something does (F23/F25 precedent).

## 31. Concurrency strategies evaluated

| Criterion | A. SELECT + INSERT | B. Row lock on professional | C. Advisory xact lock | D. SERIALIZABLE | E. Exclusion constraint | F. Slot rows + unique |
|---|---|---|---|---|---|---|
| Correctness | ❌ races at READ COMMITTED (both see free) | ✅ only if every writer locks | ✅ only if every writer locks | ✅ only if all writers SERIALIZABLE | ✅ unconditional | ✅ only for fixed grid |
| Race behaviour | double booking | second waits, re-checks | second waits, re-checks | one aborts `40001` | second waits, then `23P01` | second `23505` |
| Failure semantics | silent corruption | app-level 409 | app-level 409 | retry loop needed | deterministic `23P01` → 409 | `23505` → 409 |
| Complexity | low (but wrong) | medium; lock ordering on reschedule across two professionals (deadlock risk) | medium; hash key; lock ordering | medium-high; retries everywhere | low: one DDL + error mapping | high; slot generation/invalidation |
| Drizzle | ✅ | ✅ `.for("update")` | raw `sql` | ✅ `isolationLevel` | table ✅, constraint via custom SQL migration | ✅ |
| Migration | none | none | none | none | extension + custom migration | new table + backfill jobs |
| Testability | — | concurrent test | concurrent test | flaky-prone | concurrent test + `pg_constraint` guard | concurrent test |
| Performance | fast | serializes all bookings of a professional | same | abort/retry cost under contention | GiST index check per write; index reused for reads | large table |
| Rescheduling | ❌ | lock both old/new professional | lock both keys, ordered | ✅ | ✅ automatic on UPDATE | delete+insert slots |
| Tenant isolation | app only | app only | via key | app only | in the constraint key | in unique key |
| Protects against other writers (scripts, future modules) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |

## 32. Final concurrency decision

**E — PostgreSQL exclusion constraint** (ADR-044), with the rationale there. PostgreSQL feasibility was
**demonstrated** against the project's own database (PostgreSQL 17.6, Supabase pooler), inside a single
transaction that was **rolled back** (no persistent change; `btree_gist` confirmed still uninstalled
afterwards). The probe installed `btree_gist` in `extensions` (transactional DDL), created a temp table with the
exact constraint shape, and recorded:

| # | Operation | Result |
|---|---|---|
| A | insert 10:00–11:00 (org1, prof) | OK |
| B | insert identical interval | `23P01` `appt_probe_no_overlap` |
| C | insert 10:30–11:30 (partial overlap) | `23P01` |
| D | insert 11:00–12:00 (adjacent) | OK — half-open semantics confirmed |
| E | same professional id, **other org**, overlapping | OK — tenant-scoped |
| F | insert overlapping with `status = CANCELED` | OK — canceled does not block |
| G | insert `end_at = start_at` | `23514` (CHECK) |
| H | **UPDATE** (reschedule) D into 09:15–10:15 (occupied) | `23P01` — updates are covered |
| I | un-cancel F (CANCELED → SCHEDULED) while A exists | `23P01` — resurrection cannot double-book |
| plan | occupying-range query | `Index Scan using appt_probe_no_overlap` with all three keys in `Index Cond` |

Cross-session waiting behaviour (second writer blocks on the first's uncommitted conflicting row, then
`23P01`) is standard PostgreSQL exclusion-constraint semantics; it could not be demonstrated without
committing DDL to the shared database, so it is **proven in F27** by the mandatory concurrency tests (§48).

## 33. Transaction boundary

Exactly as ADR-044 §"Transaction boundary". Before the transaction: Zod validation, timezone lookup, time-window
checks. Inside (READ COMMITTED): [row lock for reschedule], entity/ACTIVE/association checks via `tx`, F26
engine check, `INSERT`/`UPDATE`, audit insert. After commit: usage (fail-open). Nothing is retried; `23P01` →
domain error; any error rolls back appointment + audit together.

## 34. PostgreSQL conflict mapping

| DB error | HTTP | Code | Message |
|---|---|---|---|
| `23P01` on `appointments_professional_no_overlap` | 409 | `APPOINTMENT_CONFLICT` | "The professional already has an appointment overlapping this time" |
| other `23P01` | 409 | `CONFLICT` | "Conflicting resource state" (errorHandler fallback, added in F27) |
| `23514`, `23503` | 500 | `INTERNAL_ERROR` | generic; logged — app validation must pre-empt them |

New domain errors (F27, `shared/errors.ts`): `AppointmentNotFoundError` (404 `APPOINTMENT_NOT_FOUND`),
`AppointmentConflictError` (409 `APPOINTMENT_CONFLICT`), `AppointmentOutsideAvailabilityError` (409
`APPOINTMENT_OUTSIDE_AVAILABILITY`), `InvalidAppointmentStateError` (409 `INVALID_APPOINTMENT_STATE`); reused:
`CustomerArchivedError`, `ProfessionalArchivedError`, `ServiceArchivedError` (with appointment-specific
messages), `TimezoneNotConfiguredError`, `NotFoundError`, `ValidationError`. Helper
`isExclusionViolationError(error, constraintName)`. Responses never include constraint names, SQL or driver text.

## 35. Tenant isolation

Four layers, the established pattern plus one: (1) `requireTenantContext` — `organizationId` from the path is
validated against the caller's real membership/credential, never trusted; (2) permission/scope; (3)
repositories require `TenantContext` and filter on `organization_id`; (4) composite FKs make cross-tenant
references unrepresentable; (5) the exclusion constraint is keyed on `organization_id`, so another tenant's
appointments can neither block nor be blocked. Foreign-tenant ids for appointment/customer/professional/
service → `404` (no existence leak). RLS remains off (OD-16).

## 36. Permissions

`appointments.read`, `appointments.create`, `appointments.update` (reschedule, notes, cancel, complete). No
`appointments.delete` (never deleted). No separate cancel/complete permissions — same class of action on the
same resource, the `orders.update` precedent (F23); no demonstrated need for a finer tier.

| Role | read | create | update |
|---|---|---|---|
| OWNER | ✅ | ✅ | ✅ |
| ADMIN | ✅ | ✅ | ✅ |
| MANAGER | ✅ | ✅ | ✅ |
| STAFF | ✅ | ❌ | ❌ |

STAFF read-only is consistent with every other module (including Orders). Whether front-desk STAFF should book
is a product question, not an architecture one — changing it is a one-line additive change in both permission
maps (§52). Service credentials: scopes `catalog.read` (reads) / `catalog.write` (writes), unchanged. Bookable
slots read: `appointments.read` (it reveals busy time).

## 37. Entitlement

`catalog.enabled`, reused via `requireCapability` — exactly like Services/Professionals/Scheduling. Appointments
are part of the same Na Pista operational catalog offer; no plan/billing requirement for a separate gate
exists. A dedicated `appointments.enabled` would be a Platform seed change without product justification —
**not created**. If product later sells booking separately, that becomes a Platform entitlement change then.

## 38. Audit

Same transaction as the mutation (existing `recordAuditEvent(entry, tx)`), `resourceType: "appointment"`:

| Action | When | Metadata |
|---|---|---|
| `appointment.created` | create | `professionalId, serviceId, customerId, startAt, endAt` |
| `appointment.rescheduled` | PATCH changing time/professional | `from: {startAt, professionalId}, to: {...}` |
| `appointment.updated` | PATCH notes only | `changedFields: ["notes"]` (never the note text) |
| `appointment.canceled` | cancel | `fromStatus, hasReason` |
| `appointment.completed` | complete | — |

Rescheduling gets its own action because it is the business event notifications/reporting care about.
No `appointment.confirmed`. No audit for reads or bookable-slot computation.

## 39. Usage/metering

Existing `recordUsage` → `api_requests` (the only NA_PISTA-allow-listed generic meter), fail-open, after
commit. Keys: `appointment.created:{id}`, `appointment.rescheduled:{id}:{requestId}`,
`appointment.canceled:{id}`, `appointment.completed:{id}`. Notes-only edits not metered (Order precedent for
non-lifecycle edits). No appointments-specific meter — no billing requirement.

## 40. API blueprint

All under `/v1`, organization-scoped (codebase convention), gated by `requireTenantContext` +
`requireCapability("catalog.enabled")`:

| Method & path | Permission / scope | Body / query | Success |
|---|---|---|---|
| `POST /organizations/:organizationId/appointments` | `appointments.create` / `catalog.write` | `{ customerId, professionalId, serviceId, startAt, notes? }` `.strict()` | 201 appointment |
| `GET /organizations/:organizationId/appointments` | `appointments.read` / `catalog.read` | §41 | 200 array |
| `GET /organizations/:organizationId/appointments/:appointmentId` | `appointments.read` / `catalog.read` | — | 200 |
| `PATCH /organizations/:organizationId/appointments/:appointmentId` | `appointments.update` / `catalog.write` | `{ startAt?, professionalId?, notes? (nullable) }`, at least one | 200 |
| `POST /organizations/:organizationId/appointments/:appointmentId/cancel` | `appointments.update` / `catalog.write` | `{ reason? }` | 200 |
| `POST /organizations/:organizationId/appointments/:appointmentId/complete` | `appointments.update` / `catalog.write` | — | 200 |
| `GET /organizations/:organizationId/professionals/:professionalId/bookable-slots` | `appointments.read` / `catalog.read` | `?date=YYYY-MM-DD&serviceId=` (both required) | 200 `{ timezone, date, slots: [{ localStartTime, startAt, endAt }] }` |

Appointment representation: `{ id, customerId, professionalId, serviceId, status, startAt, endAt,
durationMinutes, serviceName, servicePrice, currency, notes, cancellationReason, canceledAt, completedAt,
createdAt, updatedAt }` — `organizationId` omitted or echoed per existing module convention; never accepted
from the body. `servicePrice` is a decimal string or `null`. No `confirm` endpoint.

`bookable-slots` = F26 `serviceStartTimes` for that date (same validation/errors as F26 availability: archived
→ 409, not associated → 404, timezone → 409) converted to instants, minus slots overlapping occupying
appointments of that Professional. Advisory — documented as such in `docs/api/appointments-api.md` (F27).

## 41. Listing/filtering blueprint

- `from`, `to`: **required** local dates `YYYY-MM-DD` (inclusive), interpreted in the organization timezone —
  the same shape as F26 availability, so the Console never does timezone math for queries. Server converts to
  `[localMidnight(from), localMidnight(to + 1))` and selects appointments **overlapping** that window.
- Max range **31 days** (400 otherwise). No default range (explicit is safer than an implicit one).
- Optional filters: `professionalId`, `customerId`, `serviceId` (UUIDs), `status` (one of the three; default
  all, so canceled ones remain visible in the day view).
- Order: `start_at ASC, id ASC`. `limit` default 200, max 500. Keyset pagination deferred (a 31-day window with
  a 500 cap covers the Console's day/week views; documented limitation).
- Unknown/foreign filter ids simply match nothing (no existence leak). Unbounded full-tenant scans are
  impossible by construction (range mandatory + capped).

## 42. Console blueprint

Smallest useful UI, no calendar clone, pt-PT labels, existing client-component conventions:

- **Nav** "Marcações" → `/o/[organizationId]/appointments`: **day view** — date picker (default today in org
  timezone), professional filter, list grouped by professional sorted by time; status badges; canceled shown
  muted. Uses `GET /appointments?from=d&to=d`.
- **Create** (form/dialog): customer select (active), professional → service (only associated active services)
  → date → slot picker from `bookable-slots` (never computed client-side) → notes → submit.
- **Detail** `/o/[organizationId]/appointments/[appointmentId]`: all fields incl. snapshots (price via existing
  money formatting), times in org timezone; actions: Reagendar (same slot picker, preserved duration),
  Cancelar (reason), Concluir (enabled only after start), edit notes.
- **Integration points**: Professional detail gets a read-only "Marcações" tab; Customer detail gets a
  "Marcações" list (range-bounded).
- **Permissions**: `lib/permissions.ts` mirror gains the three permissions; buttons hidden without them (UX
  only — the API is the gate).
- **Errors**: `APPOINTMENT_CONFLICT` → "Este horário acabou de ser ocupado" + refresh slots;
  `APPOINTMENT_OUTSIDE_AVAILABILITY` → message + link to Excepções; `TIMEZONE_NOT_CONFIGURED` → link to
  Definições; archived errors → specific messages; request-id shown as today.
- Display formatting uses `Intl.DateTimeFormat` with the organization timezone from settings (never the
  browser timezone).

## 43. Notification boundary

Deferred entirely (no WhatsApp/email/SMS/push, no outbox, no webhooks). Future subscription points are the
audit actions: `appointment.created`, `appointment.rescheduled`, `appointment.canceled`,
`appointment.completed` (and a future `confirmed`). When built, they should be emitted through an outbox
written in the same transaction (`docs/events.md` direction), consumed by Qualé a Dica?! via API — never by
reading Na Pista's database.

## 44. Payment boundary

Appointment ≠ payment. No payment status, no Micha Express integration. The appointment exposes the agreed
`servicePrice`/`currency`; a future checkout (an Order, or a Micha Express payment intent via explicit API)
references the appointment id. Payment state, if ever needed on the booking (e.g. prepaid self-booking), is a
separate additive decision.

## 45. Future location/resource compatibility

Nothing in the model precludes: nullable `location_id` (timezone per location, ADR-040) and `resource_id`
with an **additional** exclusion constraint on `(organization_id, resource_id, range) WHERE resource_id IS NOT
NULL AND status <> 'CANCELED'`; buffers by indexing a buffered range; capacity > 1 via a different admission
mechanism for capacity-managed services. All additive; the professional constraint stays.

## 46. Security review

| Threat | Mitigation |
|---|---|
| Tenant leakage / trusting client `organizationId` | tenant context from membership/credential; repositories + composite FKs; foreign ids → 404 |
| Cross-tenant FK references | unrepresentable (composite FKs) |
| Cross-tenant conflict influence | `organization_id` in the constraint key (probe E) |
| Unauthorized create/cancel/complete/reschedule | `requireAuthorized` per route; STAFF read-only; scopes for service credentials |
| Archived Customer/Professional/Service | 409 on create/reschedule (§19) |
| Malicious date ranges | list range required, ≤ 31 days, limit ≤ 500; bookable-slots single date; startAt horizon ≤ 365 days, not in the past |
| Race conditions | exclusion constraint (§32) + row locks for transitions |
| Idempotency / double submit | constraint rejects duplicates (§28) |
| Raw DB error leakage | explicit mapping; errorHandler fallback for `23P01`; tests assert no constraint names |
| Price manipulation | `.strict()` bodies; snapshots server-derived only |
| Human JWT vs service credential | existing dual path; no human session used for service calls |
| Entitlement bypass | `catalog.enabled` on every route (fail closed) |
| Notes as PII | stored in Na Pista only, never in audit metadata, never sent to Platform |

No security-sensitive ambiguity found that requires stopping.

## 47. F27 implementation blueprint

**Backend (na-pista)**
1. `src/shared/money.ts` (or similar): move `DEFAULT_CURRENCY` out of `orders/service.ts`; Orders imports it.
2. `src/db/schema/appointments.ts`: table, three composite FKs, CHECKs, three btree indexes; doc comment naming
   the exclusion constraint; export from `schema/index.ts`.
3. Migration: `drizzle-kit generate` (table) → verify FK/index ordering (recurring drizzle-kit issue noted in
   F20–F25) → `drizzle-kit generate --custom --name appointments_no_overlap` containing
   `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;` + the `EXCLUDE` constraint → migrate.
4. `shared/errors.ts`: four new errors + `isExclusionViolationError`; `errorHandler`: `23P01` fallback → 409.
5. `src/modules/appointments/time.ts` (pure): `toLocal(instant, tz)`, `localToInstant(date, time, tz)` (DST
   contract), minute-alignment check.
6. `src/modules/appointments/lifecycle.ts` (pure): `assertTransition(from, action, now, startAt)`.
7. `src/modules/appointments/repository.ts`: tenant-asserted insert/get/getForUpdate/list/update/
   listOccupyingForProfessionalInRange.
8. `src/modules/appointments/service.ts`: create, list, get, patch (reschedule/notes), cancel, complete,
   bookableSlots — transaction boundary per ADR-044; audit in tx; usage after commit.
9. `schemas.ts` (Zod, `.strict()`), `routes.ts`; mount in `app.ts`.
10. `authorization/permissions.ts`: `appointments.read/create/update` per §36.
11. `docs/api/appointments-api.md`; `docs/f27-report.md`; ADR-042/043/044 status → implemented.

**Console (na-pista-console)**: `lib/api/appointments.ts` + types; `lib/permissions.ts`; nav item;
`app/o/[organizationId]/appointments/page.tsx` (day view + create), `.../[appointmentId]/page.tsx` (detail,
reschedule, cancel, complete, notes); Professional and Customer detail "Marcações" sections; error states per
§42.

**UL Platform**: none (optionally an F27 fixture script, following the F22–F26 `test(ul-platform)` fixture
commits, only if E2E needs new seed fixtures — test tooling, not production).

## 48. F27 test strategy

**Mandatory concurrency tests** (integration, real PostgreSQL, `Promise.allSettled` over the 5-connection
pool — the F22/F23 pattern; each assertion checks both the results **and** the final table state):

| # | Scenario | Expected |
|---|---|---|
| 1 | 2 concurrent creates, same professional, same interval | exactly 1 fulfilled; 1 `AppointmentConflictError`; 1 row |
| 2 | 2 concurrent creates, partially overlapping | exactly 1 fulfilled |
| 3 | 10:00–11:00 and 11:00–12:00 concurrently | both fulfilled |
| 4 | canceled appointment on the interval, then create | fulfilled |
| 5 | completed appointment on the interval, then create | rejected (`APPOINTMENT_CONFLICT`) — completed occupies |
| 6 | 2 appointments at different times, concurrently rescheduled to the same target | exactly 1 fulfilled; loser unchanged |
| 7 | two orgs, same interval, (distinct) professionals, concurrently | both fulfilled; neither affects the other |
| 8 | bookable-slots read shows the slot free for both callers, then both create concurrently | exactly 1 fulfilled — the DB decides |
| 9 | fan-out: 5 concurrent creates on the same slot | exactly 1 fulfilled |
| 10 | concurrent cancel + reschedule of the same appointment | serialized; final state consistent; loser 409 |
| 11 | un-cancel impossible: raw `UPDATE status='SCHEDULED'` over an occupied interval | `23P01` |
| 12 | constraint present: `pg_constraint` has `appointments_professional_no_overlap`, `contype='x'` | guard against accidental drop |

**Unit (pure)**: transition matrix (all allowed + all forbidden), complete-before-start, overlap/adjacency
predicate, `toLocal`/`localToInstant` incl. `Africa/Luanda` and a DST zone (gap skipped, overlap earliest),
day-boundary crossing (23:30Z → next local day), minute alignment, start-time membership (grid anchored at
interval start, duration fits, adjacent intervals not merged), duration preservation on reschedule, snapshot
builder (name/price/null price/currency), Zod schemas (strict bodies, offsets, seconds rejected, range limits,
horizon).

**Integration**: tenant-safe create (foreign customer/professional/service → 404), composite FK raw-insert
rejection, association required, archived Customer/Professional/Service on create and reschedule, cancel/
complete allowed on archived, outside availability (closed day, exception closed-marker, exception replacing
day, misaligned start, duration overflowing interval), timezone missing, audit row in same tx (and absent on
conflict rollback), usage called after commit only, error mapping (status/code/message, no constraint name
leak), snapshot immutability after Service edit, bookable slots subtract occupying appointments and ignore
canceled.

**E2E** (real HTTP + Platform): 1 create, 2 get, 3 list (range, filters, max range 400), 4 reschedule, 5 cancel,
6 complete, 7 invalid Service, 8 archived Service, 9 archived Professional, 10 archived Customer,
11 unavailable time, 12 conflicting time, 13 concurrent conflict over HTTP, 14 cross-tenant access (404),
15 STAFF forbidden to create/update (403) but can read, 16 entitlement disabled (403 `ENTITLEMENT_REQUIRED`),
17 audit rows, 18 usage, 19 full regression F20–F26 green.

**Console (Vitest/RTL)**: day view render, create flow using mocked bookable slots, conflict error message +
refresh, permission-hidden actions for STAFF, complete disabled before start, times formatted in org timezone.

## 49. Alternatives rejected

Reference-only Service; full Service snapshot; `appointment_services` table for single-service; optional
Customer; guest appointments; start+duration or start+end+duration storage; local-time storage; DRAFT;
CONFIRMED; NO_SHOW now; un-cancel; DELETE on cancel; separate cancel/complete permissions; dedicated
entitlement; appointments meter; SELECT+INSERT; professional row lock; advisory lock; SERIALIZABLE; stored
slots; booking override; `Idempotency-Key` now; HTTP call to F26; calling `getAvailabilityOrThrow`; client-side
slot computation; unbounded listing; `metadata jsonb`; customer/professional name snapshots.

## 50. Deferred scope

Self-booking/public API, guest customers, `Idempotency-Key`, CONFIRMED/`confirmed_at`, NO_SHOW, undo of
completion, recurring appointments, multi-service, multi-professional, custom duration, availability override,
buffers, capacity/classes, waitlists, resources/rooms/locations, notifications, payments, cancellation
policies, auto-completion, keyset pagination, calendar sync, payroll/commissions, Console warning for
appointments orphaned by schedule edits, STAFF booking rights (product decision).

## 51. Risks

| Risk | Mitigation |
|---|---|
| Constraint lives outside Drizzle's DSL; a future tool could drop it | custom migration + `pg_constraint` regression test; `drizzle-kit push` not used |
| `btree_gist` is database-wide on the physical DB shared with UL Platform (OD-16) | inert additive extension in `extensions`; documented; no Platform change |
| Exception-replaces-day makes the outside-hours workaround clumsy | Console prefill; revisit override only with evidence |
| No-shows recorded as cancellations until NO_SHOW exists | reason text; small backfill later |
| Retry after lost response shows a conflict | Console refresh-on-409 |
| DST edge (wall-clock end on fall-back day) | documented; absolute duration exact; Luanda has no DST |
| Past SCHEDULED appointments accumulate | explicit staff action; auto-completion deferred |
| 500-row list cap | 31-day range; keyset pagination when needed |

## 52. Open decisions

None architecture-blocking. Non-blocking product questions (each a one-line additive change, defaults chosen):
1. Should STAFF create/update appointments? Default: **no** (consistency with all modules).
2. Booking horizon of 365 days — acceptable default? Default: **yes**, constant.
3. Should completing require `now >= start_at`? Default: **yes**.

## 53. Self-review

**Domain** — [x] Appointment responsibility clear · [x] Scheduling separate · [x] Service = WHAT · [x]
Professional = WHO · [x] Appointment = actual booking · [x] Customer relationship explicit.
**Service** — [x] relationship · [x] snapshot · [x] duration snapshot · [x] price/currency snapshot.
**Time** — [x] unambiguous `timestamptz` · [x] ADR-040 timezone behaviour · [x] start/end representation.
**Lifecycle** — [x] states · [x] transitions · [x] forbidden transitions · [x] cancellation · [x] completion ·
[x] no-show decision.
**Booking** — [x] invariant · [x] overlap semantics · [x] adjacency · [x] availability advisory · [x] write
authoritative · [x] outside-availability decision.
**Concurrency** — [x] SELECT+INSERT rejected · [x] six strategies evaluated · [x] one selected · [x] insert
covered · [x] reschedule covered · [x] DB-level guarantee · [x] PostgreSQL feasibility verified (probe) ·
[x] Drizzle compatibility verified (custom migration) · [x] error mapping defined.
**Tenancy** — [x] org-scoped · [x] Customer/Professional/Service tenant-safe · [x] cross-tenant conflict
behaviour defined.
**Authorization** — [x] permissions · [x] roles · [x] lifecycle permissions.
**Entitlement** — [x] `catalog.enabled` · [x] no unjustified Platform entitlement.
**Operations** — [x] audit · [x] usage · [x] error mapping · [x] idempotency decision.
**Future** — [x] self-booking boundary · [x] notifications deferred · [x] payments deferred · [x]
multi-service · [x] multi-professional · [x] recurrence · [x] resources/locations compatible · [x] F27 needs no
F26 redesign.
**Scope** — [x] no production Appointment code · [x] no migration · [x] no UI · [x] no unrelated refactor.
**Git** — [x] status before · [x] status after · [x] no secrets committed · [x] files documented.

Honest limits: cross-session blocking was not demonstrated live (would require committing DDL to the shared
database) — it is standard PostgreSQL behaviour and is the first thing F27's tests prove (§48 #1, #2, #6, #9).

## 54. Git status

Before: all three repositories clean (§2). Files changed (na-pista only, documentation):

- `docs/adr/ADR-042-appointment-domain-model.md` (new)
- `docs/adr/ADR-043-appointment-lifecycle-state-machine.md` (new)
- `docs/adr/ADR-044-appointment-concurrency-conflict-enforcement.md` (new)
- `docs/adr/README.md` (three index rows)
- `docs/f27a-report.md` (new)

`na-pista-console` and `ul-platform`: unchanged. The feasibility probe ran from the session scratchpad (not
committed) inside a rolled-back transaction. One local commit `docs(f27a): define appointment & booking
domain` on `main`; not pushed.
