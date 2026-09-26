# F28B Report — NO_SHOW

## 1. Summary

F28B implements ADR-048 end-to-end: the fourth, terminal appointment state `NO_SHOW`, reachable only from `SCHEDULED`
once the server clock reaches `start_at`, through `POST /v1/organizations/:organizationId/appointments/:appointmentId/no-show`.
NO_SHOW keeps occupying its interval — the PostgreSQL exclusion constraint is **unchanged** (its predicate
`status <> 'CANCELED'` already covers it). Audit is transactional, usage is post-commit, authorization/entitlement/tenant
isolation follow cancel/complete exactly, and the Console detail page gains "Marcar como falta". Nothing from F28C–F28H
was implemented; UL Platform was not changed.

**Status: see §12 and the verdict at the end.**

## 2. ADR-048 implementation

| ADR-048 decision | Implementation |
|---|---|
| Terminal state from SCHEDULED only | `lifecycle.ts` `assertTransition(…, "no_show")`; every non-SCHEDULED status → `INVALID_APPOINTMENT_STATE` |
| Only once server clock ≥ `start_at`, no deadline | same time rule as `complete`; before → `409 APPOINTMENT_NO_SHOW_TOO_EARLY`; `now` optional parameter used by tests only |
| `appointments.update`, STAFF read-only | route gated like cancel/complete; service credentials `catalog.write` |
| Keeps occupying | no constraint change; proven by integration + E2E booking over a NO_SHOW → `APPOINTMENT_CONFLICT` |
| `no_show_at` + CHECK; status CHECK extended | migration `0009` |
| Audit `appointment.no_show`; usage after commit | `markAppointmentNoShow` |
| Event `appointment.no_show` | **not implemented** (Outbox is F28D); the name is a valid Platform `domain.action` type |
| No backfill of interim cancellations | none performed |
| Notes edit on NO_SHOW | rejected like every terminal state (ADR-043 rule, unchanged; stated in ADR-048's implementation note) |

## 3. Lifecycle changes

`APPOINTMENT_STATUSES = SCHEDULED | COMPLETED | CANCELED | NO_SHOW`; action `no_show` → `NO_SHOW`; `isTerminal` includes
NO_SHOW; `occupiesTime(NO_SHOW) = true` (mirrors the DB predicate). The too-early check is shared with `complete` and
throws the action-specific error. No other state or hidden transition was added.

## 4. Database changes

Migration `drizzle/migrations/0009_omniscient_cassandra_nova.sql` (generated, inspected manually, applied):

```sql
ALTER TABLE "na_pista"."appointments" DROP CONSTRAINT "appointments_status_valid";
ALTER TABLE "na_pista"."appointments" ADD COLUMN "no_show_at" timestamp with time zone;
ALTER TABLE "na_pista"."appointments" ADD CONSTRAINT "appointments_no_show_at_matches_status"
  CHECK (("status" = 'NO_SHOW') = ("no_show_at" IS NOT NULL));
ALTER TABLE "na_pista"."appointments" ADD CONSTRAINT "appointments_status_valid"
  CHECK ("status" IN ('SCHEDULED', 'COMPLETED', 'CANCELED', 'NO_SHOW'));
```

Runs in one migration transaction; every existing row satisfies both new CHECKs. **Not changed:** the exclusion
constraint, interval semantics, conflict model, Customer/Service/Professional models. No new table, no metadata column.

## 5. API changes

- `POST …/appointments/:appointmentId/no-show` — strict empty body (`z.object({}).strict()` on `req.body ?? {}`): no body
  or `{}` accepted, any field → `400 VALIDATION_ERROR`. `200` with the appointment.
- Representation: `noShowAt` added; `status` may be `NO_SHOW`.
- `GET …/appointments?status=NO_SHOW` now valid (the list schema derives from `APPOINTMENT_STATUSES`).
- New error code `409 APPOINTMENT_NO_SHOW_TOO_EARLY` (only one added). `INVALID_APPOINTMENT_STATE` now also covers
  NO_SHOW. No raw PostgreSQL error reaches clients (existing mapping unchanged).
- Documented in `docs/api/appointments-api.md` (endpoint, permission, request, response, lifecycle, temporal rule,
  errors, representation, list filter).

## 6. Authorization

`appointments.update` (OWNER/ADMIN/MANAGER allowed, STAFF → 403), service credential scope `catalog.write`,
entitlement `catalog.enabled`, tenant context from membership/credential. No permission added or changed.

## 7. Audit

`appointment.no_show` (`resourceType: "appointment"`, request id, no metadata — the same shape as
`appointment.completed`) written inside the transition's transaction. Proven: a real audit failure (NOT NULL violation
on `audit_events.actor_id`, triggered through the real `markAppointmentNoShow`) rolls back the transition — the row stays
SCHEDULED, `no_show_at` stays NULL, no audit row, no usage.

## 8. Usage

`recordUsage(org, "appointment.no_show:{id}", …)` (`api_requests`) after the transaction returns. Proven:
integration counts calls — success 1; too early 0; invalid state 0; unknown appointment 0; audit-failure rollback 0.
E2E reads the real Platform meter — +1 after a successful NO_SHOW, unchanged after too-early and invalid-state attempts.

## 9. Concurrency

No new mechanism: `getAppointmentForUpdate` (`SELECT … FOR UPDATE`) serializes transitions of the same appointment;
the exclusion constraint remains the authority between appointments. Tested on real PostgreSQL with simultaneous
transactions:

| Race | Result |
|---|---|
| NO_SHOW × 2 | exactly one NO_SHOW, the other `INVALID_APPOINTMENT_STATE`, exactly one `appointment.no_show` audit row |
| NO_SHOW vs cancel | exactly one transition applied; loser `INVALID_APPOINTMENT_STATE`; final status and its timestamp match the winner; the other timestamp NULL |
| NO_SHOW vs complete | exactly one transition; never both `no_show_at` and `completed_at`; exactly one transition audit row |

## 10. Console

`app/o/[organizationId]/appointments/[appointmentId]/page.tsx` (existing page, no new page): "Marcar como falta" shown
only with `appointments.update` and status SCHEDULED; the server decides "too early" (the browser clock is not used to
hide it); on `APPOINTMENT_NO_SHOW_TOO_EARLY` the pt-PT message is shown **and** the appointment is reloaded from the
server; on success the screen re-renders from the server response — "Falta" badge (`badge-warning`), "Falta registada …
o horário continua ocupado", all incompatible actions gone. Day view: NO_SHOW rows show the badge and are **not** muted
(they still occupy the slot; only CANCELED rows are muted). Status label/badge/type/`noShowAt`/API client/message map
updated. Existing Design System classes only.

Found and fixed during this slice: refreshing the appointment after a server-side time-rule error was clearing the
error message (the F27 reload path called `load()`, which resets the error); `load({ keepError: true })` now refreshes
state without hiding the explanation (covered by the existing completion test and the new NO_SHOW too-early test).

## 11. Tests

| Layer | New | Notes |
|---|---|---|
| Unit | 7 | too early / exactly at start / after start (+1 year) / COMPLETED & CANCELED → invalid / NO_SHOW terminal for no_show, cancel, complete, reschedule, update / occupancy / strict body / list filter |
| Integration (real PostgreSQL) | 13 | persistence, DB CHECKs via raw writes, too early, terminality, COMPLETED/CANCELED, occupancy + CANCELED still releases, audit, audit-failure rollback, usage matrix, tenant isolation, 3 concurrency races |
| E2E (real HTTP + Platform + PostgreSQL) | 11 | OWNER/ADMIN/MANAGER 200, STAFF 403, catalog.write credential 200, insufficient scope 403, no auth 401, entitlement 503/403, foreign tenant 403/404, too early 409, body 400, subsequent mutations 409, booking over NO_SHOW 409 CONFLICT, real usage meter, audit row, list filter |
| UI (Vitest + RTL) | 8 | action visibility, success re-render, too early + reload, STAFF hidden, server 403, terminal NO_SHOW, COMPLETED/CANCELED, day-view badge not muted |

Existing tests changed because the F28B contract changed them (no assertion weakened):
1. `tests/unit/appointments.test.ts` — the F27 assertion used `status=NO_SHOW` as an example of an *invalid* list
   filter; ADR-048 makes it valid, so the example became `CONFIRMED` (still invalid) and a new test asserts NO_SHOW is
   accepted.
2. Two Console test factories (`appointments/page.test.tsx`, `appointments/[appointmentId]/page.test.tsx`) gained
   `noShowAt: null` — the `Appointment` type has a new required field.

**E2E harness notes (test infrastructure only):** the API correctly refuses past bookings, so a past appointment is
produced by booking in the future and shifting that row's times in the database (the F27 completion E2E technique);
for "booking over a NO_SHOW", the NO_SHOW row is shifted back to its original future slot before the real HTTP booking
attempt. No fixture set has an ADMIN user and ul-platform must not change, so the ADMIN test creates a fresh subscribed
org via the real Platform API (named `F27_TZ_PROBE_…`, already covered by `f27:teardown`) and grants an existing fixture
user the ADMIN role via `POST /organizations/:id/memberships`.

## 12. Regression

Full F20–F28B regression (typecheck → unit → integration → E2E, against the
real Supabase-pooled PostgreSQL and a real UL Platform dev server):

| Suite | Result |
|---|---|
| typecheck (`tsc` src + tests) | pass |
| unit | 210 / 210 |
| integration | 190 / 190 |
| E2E (full run) | 220 / 224 — 4 timeouts, no assertion failure |
| E2E re-run of the 4 affected files | NO_SHOW usage test and scheduling tenant-isolation: pass; `audit-and-usage` 3/3 and `inventory-lifecycle` 6/6 tests pass, but each **file** exceeds the harness's 90 s per-file limit |
| same 2 files with `--test-timeout=300000` | 9 / 9, 185 s total |

The timeouts were environmental: the remote database was very slow during the
run (single tests took 35–85 s; one F26 test stalled ~6 min on the UL
Platform upstream and correctly got `503 UPSTREAM_UNAVAILABLE`). The two
file-level timeouts are in F20/F22 files that F28B does not touch. No
F28B-specific test failed on re-run. Console: see the F28B console commit
(`146b31a`) — its tests pass.

## 13. Limitations

- No undo for a mistaken NO_SHOW (ADR-048; audit shows who marked it) — deferred with completion undo.
- Interim F27 cancellations with a "no-show" reason are not converted (ADR-048: free text is not a reliable signal).
- The `appointment.no_show` event is not published until the Outbox (F28D) exists.
- Clients switching on `status` must handle the new value (documented).

## 14. Deferred scope

Outbox/event publication (F28D), Idempotency-Key (F28C), multi-service (F28E), buffers/occupied interval (F28F),
participants (F28G), resources (F28H), locations, capacity, CONFIRMED, undo, notifications, usage via outbox — none
touched.

## 15. Files changed

**na-pista:** `drizzle/migrations/0009_omniscient_cassandra_nova.sql`, `drizzle/migrations/meta/{_journal.json,
0009_snapshot.json}`, `src/db/schema/appointments.ts`, `src/modules/appointments/{lifecycle,repository,routes,schemas,
service}.ts`, `src/shared/errors.ts`, `tests/unit/appointments.test.ts`, `tests/integration/appointments.test.ts`,
`tests/e2e/appointments-no-show.test.ts`, `docs/api/appointments-api.md`, `docs/adr/ADR-048-appointment-no-show-lifecycle.md`,
`docs/adr/README.md`, `docs/f28b-report.md`.

**na-pista-console:** `app/o/[organizationId]/appointments/[appointmentId]/{page,page.test}.tsx`,
`app/o/[organizationId]/appointments/page.test.tsx`, `lib/api/{appointments,types}.ts`, `lib/appointments/messages.ts`,
`lib/datetime.ts`.

**ul-platform:** none.

## 16. Git commits

- `na-pista-console` — `146b31a feat(appointments): add NO_SHOW to appointment detail`
- `na-pista` — the F28B commit that contains this report (`feat(appointments): add NO_SHOW lifecycle state`)
- `ul-platform` — none (no change required)
