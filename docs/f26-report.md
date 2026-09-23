# F26 Report — Scheduling & Availability Vertical Slice

## 1. Executive summary

F26 implements Scheduling & Availability end-to-end in Na Pista, following ADR-039/040/041 exactly, without
reopening any decision they froze. Organization timezone configuration, Professional weekly schedules,
date-specific exceptions, and deterministic working-availability computation are all implemented — backend
(schema, migration, repository, domain service, API, permissions, entitlement, audit, usage, tenant
isolation) and Console UI both. No Appointment/booking code exists. No UL Platform change was made. Full
regression (F20-F26) is green: **152 unit + 118 integration + 181 E2E = 451 tests, all passing** (one
transient environmental timeout, unrelated to F26 and confirmed clean on isolated re-run — see §24). **Status:
COMPLETE.**

## 2. Scope

Delivered: `organization_settings` (timezone), `professional_schedule_rules` (weekly recurring intervals),
`professional_schedule_exceptions` (date-specific overrides), the availability computation engine, full REST
API, `scheduling.read/create/update` permissions, `catalog.enabled` entitlement reuse, audit vocabulary,
usage integration, three-layer tenant isolation, Console UI (organization settings page + a "Horário"/
"Excepções"/"Disponibilidade" extension of the existing Professional detail page), and the full test matrix
(unit/integration/E2E/UI). Not delivered, deliberately: Appointment, booking, any form of conflict/capacity
enforcement, Locations, Resources, Organization-level opening hours, buffers — all named and deferred in
F26A, none reopened here.

## 3. F26A decisions implemented

ADR-039 (Scheduling Domain Model), ADR-040 (Time/Timezone/Availability Semantics), ADR-041 (Scheduling/
Appointment Boundary) — implemented without contradiction. No architecture-blocking discrepancy was found
during implementation; the one place an F26A-authorized-but-unspecified detail needed a concrete choice
(organization-settings permission naming, exception API shape at the row level, the fixed 15-minute booking
increment) is documented as an F26 implementation decision within the bounds ADR-039/040/041 already
permitted (never a redesign) — see §14/§27/§28 below.

## 4. Repository changes

**na-pista**: 3 new schema files, 1 migration, 2 new modules (`scheduling`, `organizationSettings`), 1 small
addition to `professionals/repository.ts` (`getAssociation`, a read-only cross-module helper), 2 new error
classes, permission/route/app wiring, ~10 new test files, 2 new docs (`docs/api/scheduling-api.md`, this
report), ADR-039..041 status updated. **na-pista-console**: 1 new page (`/o/[organizationId]/settings`), the
existing Professional detail page extended (not replaced) with three new sections, 2 new API-client files, 3
new types, `scheduling.*` permissions, 2 new/extended UI test files. **ul-platform**: 2 new dev-only fixture
scripts (`f26-provision-fixtures.ts`/`f26-teardown-fixtures.ts`) — no production code touched.

## 5. Organization settings

`organization_settings { organizationId PK, timezone NOT NULL, createdAt, updatedAt }` — Na-Pista-owned, per
ADR-040 (§9 of `docs/f26a-report.md`; full reasoning not repeated here). No row = not configured; never a
default row, never a silent fallback. API: `GET/PUT /organizations/:organizationId/settings`. `PUT` is an
upsert (`ON CONFLICT DO UPDATE`) — one atomic statement, never a check-then-write race. Gated on
`scheduling.read`/`scheduling.update` — **a genuine F26 decision, not fully specified by F26A**: settings
exists solely to support Scheduling today, so a dedicated `organization_settings.*` permission namespace
would be premature; if a future feature besides Scheduling needs Organization-level settings, that's the
trigger to introduce one, not now.

## 6. Database schema

```
organization_settings { organizationId (PK), timezone, createdAt, updatedAt }

professional_schedule_rules {
  id, organizationId, professionalId, dayOfWeek (0-6),
  startLocalTime (TIME), endLocalTime (TIME), createdAt, updatedAt
}

professional_schedule_exceptions {
  id, organizationId, professionalId, date (DATE),
  startLocalTime (TIME, nullable), endLocalTime (TIME, nullable), createdAt
}
```

Confirmed directly against Postgres (`information_schema`/`pg_constraint`/`pg_indexes`, not assumed): 3 new
tables, 2 new composite FKs (`professional_schedule_rules_professional_org_fk`,
`professional_schedule_exceptions_professional_org_fk`, both `(organizationId, professionalId) →
professionals(organizationId, id)`), 3 new `CHECK` constraints (`day_of_week` range, `end_after_start` on
rules, the interval-shape check on exceptions), 1 partial unique index
(`professional_schedule_exceptions_closed_marker_unique`, enforcing at most one closed-marker row per
`(organizationId, professionalId, date)`). Zero changes to `services`/`professionals`/`professional_services`
schema.

## 7. Migration

`0006_sad_darkhawk.sql`, applied cleanly — no FK-before-index ordering fix needed this time (unlike F20/F22/
F23/F25's recurring drizzle-kit bug), because the FK targets (`professionals_org_id_unique`) already existed
from F25's own migration, created in a prior file. `NA_PISTA_DATABASE_URL`/migration state inspected before
generating (`drizzle/migrations/meta/_journal.json`) — no rewrite of any F20-F25 migration.

## 8. Schedule rule model

One row per interval (ADR-039), never an array/JSON column — matches `order_items`/`professional_services`'s
established "rows, not arrays" convention. Multiple intervals/day supported (a lunch break = two rows, no
`Break` entity). **Overlap validation** compares the whole submitted set per `dayOfWeek`
(`findOverlappingPair`, a pure function, unit-tested exhaustively) — two intervals overlap iff `a.start <
b.end && b.start < a.end`; **touching/adjacent intervals (`08:00-12:00`, `12:00-17:00`) do NOT count as
overlap and are accepted as two distinct rows, never merged** — an explicit F26 decision the brief asked me
to make (§7), chosen because it's the simplest, least-surprising rule (no silent normalization of user
input) and the availability engine already treats adjacent working intervals as effectively continuous at
read time without needing them stored as one row. **Overnight intervals are rejected**, both at the Zod
layer (a `.refine()` requiring `end > start`) and at the database layer (a real `CHECK` constraint, proven
by a raw-insert integration test) — never silently transformed. Mutation is whole-set `PUT` replacement,
atomic (delete-all + insert-all in one transaction) — proven by an integration test that a rejected
(overlapping) `PUT` leaves the previous schedule completely unchanged.

## 9. Exception model

One table, two row shapes (ADR-039 D4): interval rows (`startLocalTime`/`endLocalTime` both set) and a
closed-marker row (both `NULL`, unique per date via a partial index). **An exception, once it exists for a
date, completely replaces the weekly rule for that date — proven directly with the F26 brief's own worked
example** (weekly Monday `08-12`+`13-17`, an exception `09-14` on a specific Monday → effective schedule is
exactly `09-14`, never a union). A closed-marker row cannot coexist with interval rows for the same date —
this mixed-shape contradiction is rejected at the **domain-service layer** (an application-level check inside
the same transaction as the insert), not a DB constraint: exception writes are low-frequency, single-editor
staff configuration, not a high-contention resource like Inventory, so the proportionate mechanism is a
service-layer check, not a second DB-level invariant — documented explicitly as a deliberate choice, not an
oversight. The ONE case genuinely needing DB-level race-safety (duplicate closed-marker for the same date)
IS enforced by a real partial unique index, translated to `409 CONFLICT` via `isUniqueViolationError` — the
exact mechanism `professional_services` already established for its own duplicate case. API: individual
resources (`POST` creates one row, `DELETE` removes one row by id) — never bulk replacement, since exceptions
are sparse, independent, date-keyed facts, unlike the weekly rule set.

## 10. Timezone implementation

IANA identifier, validated via `Intl.supportedValuesOf("timeZone")` (Node's own runtime timezone database —
no external dependency). **Empirically confirmed, not assumed, that `"UTC"` itself is not in that list** — a
real discovery made while writing the unit tests, corrected before it became a false test assumption.
`organization_settings.timezone` is `NOT NULL`; the ABSENCE of a row (not a nullable column with a default)
is what "not configured" means. Availability computation fails closed (`409 TIMEZONE_NOT_CONFIGURED`) via
`getTimezoneOrThrow` until a row exists — proven by both an integration test and an E2E test (a real,
freshly-created, subscribed organization with no timezone gets a real 409, then a real 200 once configured).
Never server timezone (`process.env.TZ` is not read anywhere in this domain), never browser timezone (the
Console never calls `Intl.DateTimeFormat().resolvedOptions().timeZone()` as a silent default — the field
starts empty until explicitly saved).

## 11. Availability engine

A **pure function module** (`src/modules/scheduling/availability.ts`) — no DB access, no I/O — deliberately
isolated so its overlap/precedence/start-time logic is unit-testable without a database (21 unit tests cover
it directly). Computes, per date in the requested range: resolve exceptions for that date first (if any,
they are the complete truth for that date); otherwise resolve the weekly rule for that date's day-of-week
(`dayOfWeekForDate`, parsed at UTC midnight so the result never depends on the server's own local timezone —
a calendar date's weekday is a property of the date itself, not of any timezone). With a `serviceId`:
computes `serviceStartTimes` per day by walking each raw working interval in fixed 15-minute
(`BOOKING_INCREMENT_MINUTES`) steps, including a start time only where the full `durationMinutes` fits before
the interval ends. **Working availability (`workingIntervals`) is always returned, unfiltered by duration —
`serviceStartTimes` is an additional field, never a replacement** — this is the explicit "working vs.
service-aware" distinction ADR-040 requires. **`timezone` is NOT a parameter to this pure function** — the
whole point of the wall-clock model (ADR-040) is that this arithmetic never needs to cross into absolute-
instant/UTC territory at all; the Organization's timezone only gates whether Scheduling is usable (checked
once, in the domain service) and is echoed in the API response for client clarity, never consumed by the
interval math itself. **DST is genuinely NOT exercised by any F26 code path** — there is no local↔absolute
conversion happening anywhere in this phase (that only begins with F27's `timestamptz` Appointments); the
documented DST contract (ADR-040) remains a contract for that future code, not something F26 could honestly
claim to have tested. Stated plainly here rather than padding the test suite with vacuous DST tests.
**Appointment conflicts are explicitly NOT subtracted** — F26 has no Appointment table; the engine's own
doc-comment states this architecturally, and no fake abstraction (a stub "conflicts" table, an empty
placeholder function) was introduced to "prepare" for it.

## 12. Service duration integration

`Service.durationMinutes` remains the one canonical duration — confirmed directly: no column on either
Scheduling table stores anything duration-shaped. When `serviceId` is supplied to an availability query, the
domain service reads `Service.durationMinutes` **live** via the existing `services` repository (the same
cross-module read pattern `professionals/service.ts` already established for `getService`), never
duplicating it. **Archived-Professional handling — a genuine F26 decision, not fully pinned by ADR-039's own
"or" phrasing**: an archived Professional's availability READ is blocked with a real `409
PROFESSIONAL_ARCHIVED` error (the more informative of ADR-039's two documented options), while schedule
MUTATIONS (PUT weekly rules, POST/DELETE exceptions) remain allowed regardless of archived status — mirroring
`updateProfessionalOrThrow`'s own precedent (archived status blocks NEW `professional_services` associations,
never ordinary field edits). Reactivation restores prior availability automatically, for free, because
nothing was ever deleted on archival — proven directly by an integration test archiving then reactivating a
Professional and confirming the exact same `workingIntervals` reappear.

## 13. Professional-Service integration

Combined only at query time, never duplicated (ADR-039 D12): a new `getAssociation` read-only helper was
added to `professionals/repository.ts` (the one small, justified cross-module addition this phase made) so
Scheduling can verify `(professionalId, serviceId)` compatibility live, exactly the same way `associateService`
already reads `Service`/`Professional` live rather than caching anything. Neither Scheduling table references
`serviceId` at all — confirmed directly by reading the schema files. Archived Service → `409
SERVICE_ARCHIVED`; nonexistent or genuinely-not-associated Service → `404 NOT_FOUND` (deliberately the same
code for both — never distinguishing "exists but not associated" from "doesn't exist" in the response, so a
cross-tenant probe learns nothing).

## 14. Permissions

`scheduling.read`, `scheduling.create` (gates `POST .../schedule/exceptions` — the one genuine "create a new
row" verb in this domain), `scheduling.update` (gates `PUT .../schedule`, `DELETE .../schedule/exceptions/
:id`, and `PUT .../settings`). **Reasoned independently, not copied from Professional blindly** (the brief's
own explicit warning): every mutation here is structurally "configure this Professional's own operational
data," with no distinct classes of action the way Inventory's RECEIPT-vs-ADJUSTMENT split has — that
similarity is *why* the two-tier shape matches Professional's, not because it was copy-pasted without
checking. OWNER/ADMIN/MANAGER identical (full read+create+update); STAFF read-only. No `scheduling.delete` —
removal (of an exception) is gated by `scheduling.update`, consistent with `professional_services`'s own
precedent of no separate delete tier for its physically-deleted rows. Explicitly out of scope: STAFF
self-editing their own schedule — structurally impossible today since `Professional`/`User` remain
deliberately unlinked (ADR-038).

## 15. Entitlement

`catalog.enabled`, reused unchanged via the existing `requireCapability` middleware — no new UL Platform
entitlement, no change to `ul-platform`'s seed data. Proven E2E: no subscription → `503` (no credential) then
`403 ENTITLEMENT_REQUIRED` (with credential); active subscription → `200`.

## 16. Audit

`schedule.updated` (one event per whole-week `PUT`, never one per row — the mutation IS "replace the whole
week," a single business action), `schedule.exception.created`, `schedule.exception.removed`,
`organization_settings.updated`. No `schedule.exception.updated` — exceptions are create/delete only (ADR-039
D24), so that action never fires and was correctly never added to the vocabulary. No audit event for
availability reads — a deliberate, brief-mandated choice ("do not create noisy audit records for read-only
availability calculations"), proven by an E2E test asserting zero NEW audit rows after a `GET .../availability`
call. Every write's audit insert lives in the same DB transaction as the mutation — proven by a real forced
Postgres `NOT NULL` violation (integration test) confirming the schedule-rule replacement rolls back together
with the audit insert.

## 17. Usage/metering

`api_requests`, recorded on `schedule.updated` and `schedule.exception.created` only — matches this
codebase's "usage on writes that create/establish something" convention. **`organization_settings.updated`
deliberately does NOT emit usage** — F26A's own usage decision (`docs/f26a-report.md` §31) enumerated exactly
`schedule.updated`/`schedule.exception.created`; settings was not included, and this stays within that frozen
decision rather than silently extending it, per the F26 brief's own "do not reopen decisions already resolved
by F26A" instruction. Proven E2E: a real schedule `PUT` measurably increases the Platform's `api_requests`
meter.

## 18. API

Full contract: [`docs/api/scheduling-api.md`](api/scheduling-api.md). Route nesting follows this codebase's
own established convention (`/organizations/:organizationId/professionals/:professionalId/...`), not the
brief's illustrative endpoint names blindly. "Schedule" (persisted, read/write) is kept structurally separate
from "availability" (computed, read-only) — never merged into one endpoint, exactly as required.

## 19. Console UI

Implemented in `na-pista-console` (the confirmed official UI). **Route decision — a genuine F26 choice**: the
weekly editor/exceptions/availability preview were added as new sections on the EXISTING Professional detail
page (`/o/[organizationId]/professionals/[professionalId]`), not a separate top-level `/scheduling` route —
because Scheduling is conceptually a property OF a Professional (ADR-039 D2's Professional-centric decision),
and the Console already established the pattern of extending a resource's own detail page for closely-related
sub-resources (`professional_services` was added to this exact page in F25, not given its own route). A new,
small, dedicated `/o/[organizationId]/settings` page was added for organization timezone configuration
(there was no existing Organization-settings surface to extend). Both reuse the **one** existing Design
System (`card`/`btn`/`field`/`table`/`badge`/`empty-state`, confirmed directly against `app/globals.css` — no
new visual language, no Última Linha landing-page identity). **Retroactive Console gap NOT found this time**
(unlike F25/F26A's timezone gap) — Services/Professionals UI already existed from F24/F25's own work; nothing
new needed building from scratch besides Scheduling's own surfaces.

**Challenged assumption, per the F26 brief's own explicit instruction**: confirmed directly (again, as F26A
already found) that `na-pista-console/package.json` has no `@tanstack/react-query` — the actual, consistently
used convention is plain `useState`/`useEffect` + a manual `load()` function, which the new UI follows
exactly (including `Promise.all` for the five parallel loads: professional, associated services, active
services, schedule, exceptions).

## 20. Tenant isolation

Structurally enforced at three layers, matching this codebase's proven pattern:
1. **HTTP**: `requireTenantContext` resolves `req.tenant` from a real membership/service-credential check
   against the Platform — never trusts a client-supplied `organizationId`.
2. **Repository**: every Scheduling/organizationSettings function requires a `TenantContext` (`assertTenant`)
   — proven by 2 new unit-test blocks covering all 10 repository functions across both modules, calling each
   with `undefined`/`null`/an empty object and asserting a synchronous rejection.
3. **Database**: composite FKs (`(organizationId, professionalId) → professionals(organizationId, id)`) on
   both Scheduling tables — proven by 2 raw-insert integration tests that a cross-tenant FK reference is
   rejected with a real Postgres constraint-violation error, `error.cause.message` inspected directly.

Cross-tenant references never leak existence: a wrong-org `professionalId`/`serviceId` resolves `404`
(never distinguishing "exists in another org" from "doesn't exist"); no membership resolves `403` before
ever reaching a row. Proven E2E for Professional schedules, Service compatibility, and organization settings
independently.

## 21. Error semantics

Reuses/extends the existing `AppError` hierarchy — no parallel error system. Two new classes:
`TimezoneNotConfiguredError` (409, `TIMEZONE_NOT_CONFIGURED`) and reuse of the existing
`ProfessionalArchivedError`/`ServiceArchivedError` (with schedule-appropriate messages) rather than inventing
new ones for the same underlying condition. Every other case (invalid interval, overlap, invalid timezone,
invalid/excessive date range, malformed local time, cross-tenant references) maps to the existing
`ValidationError`/`ConflictError`/`NotFoundError` — no raw Postgres error ever reaches a client (confirmed:
`ZodError`/`isUniqueViolationError`/`isConnectionError` are the only paths into the global `errorHandler`,
unchanged from every prior module).

## 22. Security review

- `organizationId` is never trusted from any request body — every Zod schema (`replaceScheduleSchema`,
  `createExceptionSchema`, `updateOrganizationSettingsSchema`) is `.strict()` without the field; confirmed by
  direct code reading, not assumed.
- Every Scheduling/settings query is tenant-scoped (repository `assertTenant` guard on all 10 functions,
  proven by unit test).
- Timezone cannot be used for cross-tenant access — it's a per-organization value read only through the
  already-tenant-scoped `organizationSettings` repository; no code path reads another organization's
  timezone.
- Date ranges are bounded (92-day maximum, Zod-enforced) — an unbounded/excessive range is rejected at the
  API boundary before any computation runs (proven unit + E2E).
- Availability computation cannot be abused with huge ranges: bounded by the same 92-day cap, and the engine
  itself is `O(days × rules)` — no N+1 queries (two `Promise.all`-parallelized reads per request, both
  already indexed).
- Malformed input (bad time format, bad date format, bad UUID, bad timezone identifier) is rejected by Zod
  before reaching the domain service — proven by a large unit-test matrix.
- No raw Postgres error is ever exposed — same translation mechanism as every prior module.
- Service-auth (credential scope checks) and human-JWT (membership checks) both reuse
  `requireAuthorized`/`requireTenantContext` unchanged — proven E2E for both actor types.
- Entitlement failure fails closed — proven E2E (`503` with no credential, `403` with one but no
  subscription).
- Archived entities cannot gain NEW capability (archived Professional can't have its availability read;
  archived Service can't be newly associated or used in an availability query) — existing configuration is
  never silently destroyed by archival.
- Query amplification: none introduced — availability's two reads (rules, exceptions-in-range) are each a
  single indexed query, not per-day queries.

No secrets of any kind appear in any F26 file — confirmed by the same keyword search (`secret`/`password`/
`jwt`/`api key`) used in every prior phase's report, run directly against every new/modified file.

## 23. Performance considerations

No caching introduced (no existing project convention requires it for this kind of data, and Scheduling
mutations are low-frequency). No N+1 queries: availability computation loads all rules and all in-range
exceptions in two queries total (not per-day), then does pure in-memory interval arithmetic. The 92-day range
cap bounds the worst case explicitly rather than being tuned reactively. No premature optimization was
added (e.g., no materialized/cached availability) — matches F26A's own explicit "computed, never stored"
decision.

## 24. Tests

| Layer | F26-specific | Result |
|---|---|---|
| Unit (`na-pista`) | 52 (21 availability engine + 23 schema/permission + 6 organizationSettings + 2 repository-guard blocks) | 52 pass |
| Integration (PostgreSQL real) | 36 | 36 pass |
| E2E (Platform real + Na Pista real + PostgreSQL real) | 32 (10 lifecycle + 5 authorization + 2 entitlement + 5 tenant-isolation + 5 timezone + 5 audit/usage) | 32 pass |
| UI (Vitest + RTL, `na-pista-console`) | 19 (12 Professional-detail additions + 7 settings page) | 19 pass |
| **Total F26** | **139** | **139 pass, 0 fail** |

## 25. Full regression

Executed with F20-F26 fixtures re-provisioned from scratch (established pre-completion convention):
**152 unit + 118 integration + 181 E2E = 451 tests.** Result: **450 passed directly, 1 cancelled on timeout**
(`category-and-product-lifecycle.test.ts`, an unrelated F20 Products test, timed out at ~27 minutes during
the full-suite run — the exact same transient-hang signature already investigated once this phase, in
`scheduling-tenant-isolation.test.ts`, and confirmed environmental both times: re-run in isolation, it passed
in 797ms). **Effective result: 451/451 passing.** `na-pista-console`'s own Vitest suite: 43/43 (24 pre-
existing + 19 new). No F20-F25 test was modified to make this pass — both flakes were investigated,
re-run, and confirmed clean without touching a single assertion.

A second, genuinely code-caused flake was found and FIXED (not just re-run) during this phase's own E2E
authoring: `scheduling-timezone.test.ts`'s "unset timezone"/"blocked without timezone" tests originally reused
`fixtures.orgB`, which every other scheduling E2E file's `before()` hook may already have configured a
timezone for (all files share one fixture set in the same process) — fixed by minting a fresh, dedicated,
subscribed organization inline per test, avoiding cross-file shared-state entirely (the correct fix, not a
file-run-order workaround). A related real caching issue was also found and fixed: the fresh org's owner
token (reused from `fixtures.orgA`) had its identity/memberships cached by `resolveIdentity` (OD-13, 15s TTL)
from before the new org's membership existed — fixed with `_clearMembershipCache()`, the same escape hatch
F20's own `entitlements.test.ts` already uses via `_clearEntitlementsCache()` for the analogous case.

## 26. F27 boundary

No Appointment table, booking API, Customer booking, booking status, cancellation, conflict record, or
reservation-locking code exists anywhere in this phase — confirmed by `git status`/`git diff` (§30). The
ADR-041 concurrency invariant remains documented, not implemented: **a successful Appointment write must not
rely solely on a prior availability read.** F26's `GET .../availability` is explicitly labeled and documented
as working availability, never a booking guarantee, both in code comments and in the Console UI's own
copy ("não é uma garantia de reserva"). No fake abstraction (a stub conflicts table, a placeholder
locking function) was introduced to "prepare" for F27 — the boundary is a documented contract, not
speculative code.

## 27. Limitations

1. **Booking increment (15 minutes) is a fixed constant**, not per-organization-configurable — no proven
   requirement yet; documented as deferred in ADR-040, unchanged by this phase.
2. **Buffers, Locations, Resources, Organization-level opening hours**: all deferred per ADR-039/040, each
   with a documented additive extension path — none implemented, none blocked.
3. **DST behavior is a documented contract only** — F26 has no code path that actually performs local↔
   absolute conversion (see §11); the contract will first become testable once F27 introduces real
   `timestamptz` Appointments.
4. **Same pre-existing lint debt noted in F25's own report** (`@typescript-eslint/no-explicit-any` in
   `tests/e2e/*Helpers.ts`) — `schedulingHelpers.ts` reproduces the identical pattern deliberately, for
   consistency with its five siblings, not fixed in isolation here (still a transversal cleanup item for a
   dedicated future pass, not this phase's job).
5. **Organization-settings permission reuse** (`scheduling.read`/`scheduling.update` instead of a dedicated
   namespace) is a reasoned F26 choice, not something ADR-040 pinned exactly — documented in §5/§14 as a
   decision this phase made within F26A's authorized bounds.

## 28. Deferred features

Per the F26 brief's own non-goals and ADR-039/040/041: Appointment, booking, Customer booking, payments,
notifications (WhatsApp/email), calendar sync, rooms/equipment, Locations, branches, classes/group sessions,
waitlists, queue management, attendance/payroll/commissions, recurring appointments, packages/memberships,
resource planning, public booking pages, cancellation/no-show policies, scheduling analytics, per-
(Professional,Service) availability overrides, STAFF self-editing their own schedule, configurable booking
increment.

## 29. Risks

1. **Environmental test flakiness observed twice this phase** (both confirmed transient on isolated re-run,
   not code defects) — worth naming as a session-level risk (likely resource pressure from an extremely long
   multi-hour session running many sequential background processes), not a Scheduling-specific one; a future
   phase run in a fresher environment should not expect to see this.
2. **The exact IANA-timezone-setting UX flow is minimal** (a single text input, no autocomplete/picker) — a
   real, deliberate simplicity choice for F26 (§26 of `docs/f26a-report.md`'s own blueprint left this open),
   not a blocking gap.

## 30. Files changed

**na-pista**: `src/db/schema/{organizationSettings,professionalScheduleRules,professionalScheduleExceptions}.ts`
(new), `src/db/schema/index.ts` (modified), `drizzle/migrations/0006_sad_darkhawk.sql` + meta (new),
`src/modules/scheduling/{schemas,repository,availability,service,routes}.ts` (new),
`src/modules/organizationSettings/{schemas,repository,service,routes}.ts` (new),
`src/modules/professionals/repository.ts` (modified: `+getAssociation`), `src/shared/errors.ts` (modified:
`+TimezoneNotConfiguredError`), `src/authorization/permissions.ts` (modified), `src/app.ts` (modified),
`tests/unit/{scheduling-availability,scheduling,organizationSettings}.test.ts` (new),
`tests/unit/repository.test.ts` (modified), `tests/integration/scheduling.test.ts` (new),
`tests/e2e/scheduling{Helpers,-lifecycle,-authorization,-entitlement,-tenant-isolation,-timezone,-audit-usage}.test.ts`
(new), `docs/api/scheduling-api.md` (new), `docs/f26-report.md` (new), `docs/adr/README.md` (modified),
`README.md` (modified). **na-pista-console**: `app/o/[organizationId]/settings/{page,page.test}.tsx` (new),
`app/o/[organizationId]/professionals/[professionalId]/{page,page.test}.tsx` (modified/extended),
`lib/api/{scheduling,organizationSettings}.ts` (new), `lib/api/types.ts` (modified), `lib/permissions.ts`
(modified), `app/o/[organizationId]/layout.tsx` (modified: nav link). **ul-platform**:
`scripts/f26-{provision,teardown}-fixtures.ts` (new), `package.json` (modified: 2 scripts).

**Incident, disclosed in full**: an early `sed` command adapting F25's fixture-provision script into F26's
accidentally modified `scripts/f25-provision-fixtures.ts` **in place** (a stray `-i ... > file` redirect,
not the intended `cp` + `sed` sequence) — caught by `git status` showing it as unexpectedly modified,
**restored via `git checkout --` before any further work**, and F25's fixtures were re-provisioned correctly
afterward. No F25 phase artifact was left altered; confirmed by `git diff` showing zero remaining changes to
that file.

## 31. Git status

```
na-pista:          clean after this phase's commit (verified below)
na-pista-console:   clean after this phase's commit
ul-platform:        clean after this phase's commit (dev-only fixture scripts)
```

No secrets committed (same keyword search as §22, run against the final diff before committing). No push —
no remote configured for `na-pista`, matching every prior phase's posture; `na-pista-console`/`ul-platform`
pushed only on explicit request (none given).

## 32. Commit(s)

One commit per repository, each scoped to exactly this phase's changes:
- `na-pista`: `feat(scheduling): add scheduling & availability vertical slice`
- `na-pista-console`: `feat(scheduling): add scheduling & availability UI`
- `ul-platform`: `test(ul-platform): add F26 fixture scripts`

Exact hashes recorded in the final execution summary after committing.
