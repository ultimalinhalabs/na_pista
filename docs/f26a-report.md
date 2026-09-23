# F26A Report — Scheduling & Availability Domain Decision Spike

## 1. Executive summary

F26A is a pure decision spike — no production Scheduling/Appointment code, no migrations, no API, no UI.
The real repositories (`na-pista`, `na-pista-console`, `ul-platform`) were inspected directly before any
decision was made, and F18's own prior sketch (`domain-model.md` SD-1..SD-5) was validated against that
inspection rather than trusted blindly — one of its assumptions (`TenantSettings.timezone`) turned out not
to exist anywhere and had to be resolved from scratch (§9 below).

**Result:** Scheduling is a small, Professional-centric, additive domain — two new tables
(`professional_schedule_rules`, `professional_schedule_exceptions`) plus one small Na-Pista-owned settings
table (`organization_settings`, for timezone). It consumes `Service.durationMinutes` and
`professional_services` read-only, requires zero changes to `Product`/`Customer`/`Inventory`/`Orders`/
`Service`/`Professional`/`professional_services`, and requires zero UL Platform changes. Three ADRs
(039–041) record the durable decisions. **Status: COMPLETE** — every mandatory decision area (D1–D36) and
every critical architectural question (§6 of the brief, 52 items) is resolved with evidence or explicit,
reasoned architecture; nothing blocks F26 implementation.

## 2. Repository inspection

Performed directly, not assumed, before any decision:

**na-pista:** `src/db/schema/{professionals,services,professionalServices,categories,_helpers}.ts` (exact
current columns/constraints/indexes), the F25 migration (`0005_gorgeous_charles_xavier.sql`) and its
composite-FK pattern, `src/modules/{professionals,services,customers}/*` (repository/service/routes/schemas
conventions), `src/authorization/permissions.ts` (exact permission vocabulary and its own documented
reasoning per phase), `src/middleware/{requireCapability,requireAuthorized}.ts` (entitlement/permission gate
mechanics), `src/tenancy/tenantContext.ts` (tenant resolution), `src/shared/errors.ts` (the full `AppError`
hierarchy, `isUniqueViolationError`/`extractErrorCode`), `src/modules/audit/service.ts` (transactional audit
write, "log loudly, never silent, rolls back with the transaction"), `src/platform/usage.ts` (existence
confirmed), `docs/domain-model.md` §3 SD-1..SD-5 (F18's original Scheduling sketch — validated, one
assumption corrected, see §9), `docs/adr/ADR-035/ADR-038` (the existing four-way boundary), `docs/adr/
README.md` (confirmed next ADR number is 039 by listing the directory, not assumed).

**na-pista-console:** `package.json` (confirmed **no** `@tanstack/react-query` or any React Query package is
installed — the brief's own assumption of "TanStack Query conventions" does not correspond to reality, see
§38), `app/o/[organizationId]/{layout.tsx,professionals/page.tsx,professionals/[professionalId]/page.tsx,
services/*}` (the actual established data-fetching convention: plain `useState`/`useEffect` + a manual
`load()` function, permission-aware rendering via `roleCan`), `lib/permissions.ts` (UX-only mirror of
server permissions), `app/globals.css` (the one shared stylesheet — confirmed there is exactly one Design
System, not several).

**ul-platform:** `src/db/schema/organizations.ts` (confirmed: `id, name, slug, createdBy, createdAt,
updatedAt` — **no timezone/locale field**), a repository-wide search for `TenantSettings`/`timezone`/
`locale` (confirmed: **no `TenantSettings` table exists anywhere**; `profiles.locale` is a per-*user*, not
per-Organization, field, and is unrelated), `src/db/seed/data.ts` (`PLAN_ENTITLEMENTS` — confirmed
`catalog.enabled` is NA_PISTA's only entitlement both STARTER and BUSINESS share; `advanced_reports.enabled`
is the one BUSINESS-only example, proving dedicated entitlements *do* get created when packaging genuinely
requires it — used as the comparison basis in §29), `src/middleware`/`requireCapability`-equivalent
mechanics (confirmed how entitlement keys are opaque strings with no Platform-side product validation).

## 3. Current domain baseline

Confirmed directly against real schema code (not the brief's summary, which matched exactly):

```
Service        { id, organizationId, name, description?, durationMinutes, price?, status, createdAt, updatedAt }
Professional   { id, organizationId, name, description?, phone?, email?, status, createdAt, updatedAt }
professional_services { id, organizationId, professionalId, serviceId, createdAt }
```

`professional_services` tenant-safety: two composite FKs, both anchored on the join table's own
`organization_id` (`(organizationId, professionalId) → professionals`, `(organizationId, serviceId) →
services`) — confirmed in `src/db/schema/professionalServices.ts`. Association rules (both-ACTIVE-required,
409 on duplicate, 404 cross-tenant, survives archival, physical-delete disassociation) confirmed in
`src/modules/professionals/service.ts`. This baseline is **not redesigned** anywhere in this spike.

## 4. Scheduling definition (D1)

Scheduling stores **recurring weekly rules** plus **date-specific exceptions**; availability is always
**calculated**, never persisted as slots. Canonical source of truth = the stored rule/exception rows;
computed availability is a pure derivation, recomputed on every read, never cached in a way that could drift
from the rows that produced it. Full model: ADR-039.

## 5. Domain ownership (D2)

**Professional-centric.** A Professional has exactly one working-hours configuration, independent of which
Services they perform. `professional_services` already answers "can this Professional do this Service";
Scheduling answers the orthogonal question "is this Professional working at all." Per-(Professional,
Service) overrides are rejected for F26 (no demonstrated need) with a documented additive path. Full
reasoning: ADR-039.

## 6. Recurring schedule model (D3)

`professional_schedule_rules`, one row per interval (`dayOfWeek`, `startLocalTime`, `endLocalTime`) — rows,
never an array/JSON column, matching this codebase's established "rows, not arrays" convention
(`order_items`, `professional_services`). Multiple intervals/day = multiple rows. Closed day = zero rows for
that `dayOfWeek`. Overlapping or zero-length intervals within the same day: **rejected at write time**
(`ValidationError`, 400). **Overnight intervals (22:00→02:00): NOT supported in F26**, deferred with a
documented additive path (`spansMidnight` flag or two same-day rows later) — no current use case demonstrates
the need, and building the "which day" ambiguity resolution now would be speculative. Full model: ADR-039.

## 7. Exception model (D4)

One table, two row shapes: interval rows (`date` + non-null `startLocalTime`/`endLocalTime` = "available
these hours this date," can both narrow *and widen* a normal day, including opening a normally-closed day)
and a closed-marker row (`date` + both times NULL = "fully unavailable this date," unique per date via a
`CHECK`/uniqueness constraint). **Precedence: an exception, if one exists for a date, completely replaces
the weekly rule for that date** — never a partial merge. Deterministic, no ambiguous "does the exception add
or subtract" question to answer at read time. Full model: ADR-039.

## 8. Break semantics (D5)

**No dedicated Break entity.** A lunch break is two rows on the same day (`08:00–12:00`, `13:00–17:00`) —
interval composition already expresses it with zero new concepts, exactly the brief's own suggested minimal
outcome. Same technique covers exception-day partial closures.

## 9. Timezone decision (D6)

**Corrects a real gap found during inspection**: F18's `domain-model.md` SD-3 assumed
`TenantSettings.timezone` would exist. It does not — confirmed directly (§2 above). **Decision: Na Pista owns
timezone, in its own schema, via a new `organization_settings { organizationId PK, timezone, createdAt,
updatedAt }` table — not a UL Platform change.** Rationale: no other UL product has a demonstrated
cross-application need for organization timezone today; adding it to the shared `organizations` table would
be new Platform surface for one current consumer, against the project's own decision-discipline ordering
(CLAUDE.md §14: simplicity before premature generalization) and repository-boundary rule (§2: business-
domain concerns stay in the product). API representation: IANA identifier string (`"Africa/Luanda"`),
validated via `Intl.supportedValuesOf("timeZone")`. DB representation: `text`. **No silent fallback** — never
server timezone, never browser timezone, never a permanent locale inference; Scheduling fails closed until
an organization explicitly sets one (a UX default may be *offered*, never silently assumed). Full reasoning
and future multi-location implication: ADR-040.

## 10. Date/time representation (D7)

Explicit type split, confirmed against this codebase's own existing column-type vocabulary (only
`timestamp(tz)`/`numeric`/`integer`/`text`/`uuid`/`jsonb` used anywhere today — Scheduling is the first
module to introduce `TIME`/`DATE`, both natively supported by Drizzle's `pg-core`, no new dependency needed):
recurring rule/exception times = Postgres `TIME` (wall-clock, re-resolved against the org's *current*
timezone at read time); exception dates = Postgres `DATE`; future Appointment timestamps (F27) =
`timestamptz`, matching every other timestamp in this codebase. API: `"HH:mm"` / `"YYYY-MM-DD"` for
Scheduling, full ISO-8601 `timestamptz` strings for future Appointments (matching Order's convention). Full
table and reasoning: ADR-040.

## 11. DST behavior (D8)

Documented expectation for the *future* implementation, not built now: a nonexistent local time (spring-
forward gap) is skipped for that occurrence; a repeated local time (fall-back ambiguity) resolves to its
first occurrence — both delegated to a proven date/timezone library at implementation time (library choice
not decided here), never hand-rolled DST arithmetic. Angola has no DST today; the architecture must not
assume it never will. Full reasoning: ADR-040.

## 12. Service duration interaction (D9)

`Service.durationMinutes` remains the **one** canonical duration — Scheduling never stores it anywhere. A
`serviceId`-filtered availability query reads it live via the existing `services` repository. Directly
answers the brief's own question: **Scheduling does not duplicate duration.** Full reasoning: ADR-040.

## 13. Slot strategy (D10)

**Continuous ranges stored, slots always derived** — validates (not blindly inherits) F18 SD-3's original
"computed, never stored" reasoning. Three distinct "granularity" concepts kept explicitly separate: booking
increment (a policy, not stored data — F26A defers per-organization configurability, a fixed constant
suffices if needed at all), UI display increment (pure Console concern), generated slot duration (derived
from `Service.durationMinutes`, never stored). **F26/F27 split made explicit**: F26 may return raw working
intervals (optionally duration-filtered); precise bookable start-time generation is deferred to F27, since it
is only meaningful once Appointment conflicts exist to subtract. Full reasoning: ADR-040.

## 14. Buffer decision (D11)

**Deferred again** (F24A already deferred it once; F26A confirms the deferral rather than silently letting it
lapse) — no demonstrated requirement. **Future owner, if ever added: `professional_services`** (the
association row) — not `Service` (buffer is often professional-specific) and not `Professional` (buffer is
often service-specific); the pair is the natural join point, purely additive (two nullable integer columns),
zero redesign. Full reasoning: ADR-040.

## 15. Professional-Service interaction (D12)

Availability and compatibility are two independent facts combined only at query time:
`schedule ∩ professional_services(ACTIVE, ACTIVE) ∩ Service.durationMinutes [∩ future Appointment conflicts]`.
Neither Scheduling table references `serviceId` — confirmed directly in ADR-039's schema. Scheduling never
re-implements the N:M relationship `professional_services` already owns.

## 16. Archived entity behavior (D13)

Archiving a Professional **never deletes** schedule rules/exceptions (historical preservation, matching every
other archive operation in this codebase). An archived Professional's computed availability reads as
unavailable/empty. Reactivation restores prior availability automatically — nothing was ever deleted, so
there is no separate restore mechanism. Archiving a Service has zero effect on any Professional's stored
schedule (Service-agnostic ownership); a `serviceId`-filtered query against an archived Service fails the
compatibility check at query time only. Removing a `professional_services` association destroys no
Scheduling data. Full reasoning: ADR-039.

## 17. Availability computation

Conceptual algorithm (documented, not built — F26 vs. F27 boundary marked explicitly):

1. Resolve Organization timezone (`organization_settings`) — fail closed (400/409-shaped error) if unset.
2. Resolve Professional; reject/empty if not `ACTIVE`.
3. Resolve requested `from`/`to` range; reject if malformed or exceeding the maximum horizon (§36).
4. Load weekly recurring rules for the Professional.
5. Load date-specific exceptions in range; for any date with at least one exception row, replace that date's
   rules entirely with the exception's own rows (§7).
6. **[F26 stops here for the base case.]** If `serviceId` is present: resolve Service, require `ACTIVE`,
   verify a `professional_services` row exists, read `Service.durationMinutes`; narrow the working intervals
   to ones long enough to fit the service.
7. Produce working intervals — this is F26's full output.
8. **[F27, not F26]** Subtract conflicting Appointments.
9. **[F27, not F26]** Derive valid bookable start times (booking increment) if the API is asked for slots.
10. Convert output timestamps deterministically for the API response (§10).

Step 8/9 are explicitly out of scope for F26 — see §18/§20.

## 18. Working vs. bookable availability (D14)

**Working availability** (F26 owns fully): raw open intervals with zero knowledge of any booking — "when
could this professional conceivably work." **Bookable availability** (F27's, not F26's): working minus
Appointment conflicts (and later buffers) — "what can actually be booked right now," impossible to compute
before Appointment exists. F26's endpoint must be named/labeled unambiguously as *working* availability so no
client ever treats it as a booking guarantee. Full reasoning: ADR-040.

## 19. Scheduling vs. Appointment boundary (D15)

Scheduling = "when CAN this Professional work." Appointment (F27) = "what HAS BEEN/WILL BE booked" — owns
booking status, Customer, Service/Professional snapshot, start/end `timestamptz`, cancellation, conflict
locking. **Scheduling contains zero Customer reference, ever**, and never becomes a reservation system. Full
ownership table and reasoning: ADR-041.

## 20. Future conflict/concurrency model (D16)

**Invariant, enforced by F27, documented now: a successful Appointment write must not rely solely on a
previous availability read.** `GET .../availability` is advisory only. Leading conceptual mechanism for F27
to evaluate (validates F18 SD-4, not invented fresh): a Postgres exclusion constraint on a `tstzrange`
scoped to `(organizationId, professionalId)` via `btree_gist`, provable with the same "force two real
concurrent writes, assert exactly one wins" pattern this project has already used twice (Inventory F22,
Orders F23). Not selected as final — alternatives (row locking, advisory locks, application-level
transactional re-check) remain open for F27's own evaluation. Full reasoning: ADR-041.

## 21. Capacity decision (D17)

Initial invariant: **one Professional = capacity 1** — no two overlapping Appointments for the same
Professional, naturally enforced by the exclusion-constraint candidate above. Capacity > 1 (group classes)
explicitly deferred with a documented additive path; nothing in Scheduling's own model presumes or blocks it.

## 22. Multi-professional decision (D18)

Initial invariant: **one Appointment → one Professional.** Team bookings deferred, additive path documented
(an `appointment_professionals` join table mirroring `professional_services`'s N:M pattern).

## 23. Multi-service decision (D19)

Initial invariant: **one Appointment → one Service**, restating F24A/ADR-035's already-made decision and F18
SD-5. Multi-service appointments remain OD-09, deferred, with the same additive-join-table extension path.

## 24. Organization-hours decision (D20)

**Not needed for F26.** Professional-level availability alone is sufficient — a Professional's own schedule
already fully expresses "closed" (zero rules); a separate Organization-level ceiling has no demonstrated
requirement. Documented additive future layer (an intersection filter) if ever needed.

## 25. Locations decision (D21)

**Deferred.** Single-location Angola SMB is the assumed MVP shape (CLAUDE.md: no premature scale
complexity). Additive future path: `Organization → Location → Professional` availability, with an optional
`locationId` addable to `professional_schedule_rules` later (same "add a nullable FK" pattern `Order.
customerId` already used) — no redesign of the row shape decided in ADR-039.

## 26. Resources decision (D22)

**Deferred**, same reasoning as Locations — no proven need (rooms/chairs/equipment) for the initial
barbershop/personal-service SMB use case. Additive future path: a `resource_services`-shaped table mirroring
`professional_services`, or a capacity concept at the Appointment layer — explicitly **not** a generic
"Resource" abstraction invented speculatively now, per the brief's own instruction.

## 27. API contract (conceptual, D23/D24 — not implemented)

Consistent with this codebase's existing `/v1/organizations/:organizationId/<resource>` nesting (confirmed
directly against `professionals`/`services` routes, not assumed):

```
GET    /v1/organizations/:organizationId/professionals/:professionalId/schedule
PUT    /v1/organizations/:organizationId/professionals/:professionalId/schedule
GET    /v1/organizations/:organizationId/professionals/:professionalId/schedule/exceptions
POST   /v1/organizations/:organizationId/professionals/:professionalId/schedule/exceptions
DELETE /v1/organizations/:organizationId/professionals/:professionalId/schedule/exceptions/:exceptionId
GET    /v1/organizations/:organizationId/professionals/:professionalId/availability?from=&to=&serviceId=
```

`schedule` = persisted configuration (read/write); `availability` = computed, read-only, GET-only (you
cannot `PUT` availability directly — only the rules that produce it, matching §4's canonical-source-of-truth
decision). Weekly rules use whole-set `PUT` replacement (a 7-day × N-interval shape naturally edited together
in one form); exceptions use individual `POST`/`DELETE` by id (sparse, independent, date-keyed facts —
bulk-replace semantics would be needlessly destructive for something naturally append/remove). Duplicate
exception for an already-excepted date → `409 CONFLICT` (mirrors `professional_services`'s own duplicate
handling); `DELETE` of an already-removed exception → `404`, never a silent no-op (mirrors association
removal, ADR-037/F25).

## 28. Permission model (D25)

Minimum vocabulary: `scheduling.read`, `scheduling.create`, `scheduling.update` — **no `scheduling.delete`**
(no lifecycle state requiring one, §34). Shape mirrors `professionals`'s own two-tier split, but the
justification is restated independently, not copied blindly (per the brief's own explicit warning):
Scheduling mutations are all "configure this Professional's own operational data," structurally identical in
kind to Professional's own create/update split — no distinct classes of action exist the way Inventory's
RECEIPT-vs-ADJUSTMENT split does. Roles: OWNER/ADMIN/MANAGER = read+create+update (identical, matching every
recent module's precedent); STAFF = read only. **Explicitly out of scope**: STAFF self-editing their own
schedule — impossible today since `Professional`/`User` remain deliberately unlinked by default (ADR-038);
a real future refinement, not built.

## 29. Entitlement model (D26)

**Reuse `catalog.enabled` — no new UL Platform entitlement.** Inspected `PLAN_ENTITLEMENTS` directly:
`advanced_reports.enabled` proves dedicated entitlements *do* get created when packaging genuinely requires
independent switchability — but nothing in this phase (or any prior brief) establishes Scheduling must be
independently sellable from Service/Professional, which already gate on `catalog.enabled`. If product/
billing later decides otherwise, that is a real, separate future decision — not invented speculatively here.
**No Platform gap identified.**

## 30. Audit model (D27)

Minimal vocabulary, smaller than the brief's own hypothesis list because D24 already rules out in-place
exception edits: `schedule.updated` (one event per whole-week `PUT` replacement — a single business action,
not one event per row), `schedule.exception.created`, `schedule.exception.removed`. No `schedule.exception.
updated` — exceptions are create/delete only. Same transactional pattern as every other module (audit insert
in the same DB transaction as the mutation).

## 31. Usage/metering (D28)

Reuse `api_requests`, recorded on `schedule.updated` and `schedule.exception.created` only (matches this
codebase's "usage on writes that create/establish something" convention — e.g. Professional records usage
only on `professional.created`, never on `PATCH`). No new metering key invented — no product/billing
justification exists.

## 32. Tenant isolation (D29)

Every Scheduling table: `organizationId NOT NULL` + composite FK back to `professionals.(organizationId,
id)` — the exact pattern `professional_services` already established (ADR-037), not reinvented. Repository
requires `TenantContext` for every function (`assertTenant`, same guard convention). Cross-tenant
`professionalId` in the path → `404`, never leaks existence — confirmed as the actual existing convention by
inspecting `professionals`/`services` code directly.

## 33. Error semantics (D30)

Reuses/extends the existing `AppError` hierarchy — no parallel error system. Professional not found →
generic `NotFoundError`; archived Professional attempting a schedule mutation → a `PROFESSIONAL_ARCHIVED`-
shaped 409 (reusing or extending the existing `ProfessionalArchivedError`, an F26 implementation detail);
invalid/overlapping intervals within one request → `ValidationError` (400, request-shape only); overlapping/
duplicate exceptions → `ConflictError` (409, requires DB state); invalid timezone/date-range/malformed local
time → `ValidationError` (400) at the Zod boundary; archived Service in a query → reuse `ServiceArchivedError`;
cross-tenant references → `NotFoundError` (404). No raw Postgres error ever reaches a client — same
`extractErrorCode`/`isUniqueViolationError` translation pattern used throughout this codebase.

## 34. Lifecycle/delete semantics (D31/D32)

**No separate Schedule status** — a Professional always conceptually has a schedule (possibly empty);
`ACTIVE|ARCHIVED` on the schedule itself would duplicate `Professional.status` for no benefit. **Weekly rules
and exceptions are physically deleted**, not archived — Scheduling rows are configuration, not a business/
historical record the way Professional/Service/Order are; `professional_services` already established
physical delete as the correct posture for this *kind* of table (relationship/configuration), and Scheduling
follows that precedent, not Professional's.

## 35. Empty-schedule semantics (D33)

Zero rules and zero exceptions = **UNAVAILABLE**, always — fail-closed, matching ADR-017's established
project-wide posture. "Unrestricted" is explicitly rejected (a brand-new Professional would wrongly appear
bookable 24/7); "inherit organization schedule" is explicitly rejected (§24 — no Organization-level schedule
exists to inherit from).

## 36. Query-range constraints (D34)

The future availability endpoint must impose a maximum `from`/`to` range — an architectural expectation ("a
few months, not years"), not a tuned constant decided here, enforced by Zod validation (400 if exceeded) to
prevent unbounded computation (e.g., a 20-year request materializing an enormous number of derived
intervals). Same class of boundary check as every other validated input in this codebase.

## 37. Self-booking boundary (D35)

F26 = **staff-managed** scheduling only (an authenticated Organization member with `scheduling.*`
permission). No public/customer-facing endpoint in F26. A later phase would additionally need: public
availability read, rate limiting, a booking policy, and a real Customer-auth/guest flow — none in scope now.
Full reasoning: ADR-041.

## 38. Na Pista Console contract (conceptual, D36 — not built)

**Route: extend the existing Professional detail page** (`/o/[organizationId]/professionals/
[professionalId]`) with a new "Horário" section — **not** a separate top-level `/scheduling` route, mirroring
exactly how "Serviços associados" was added to that same page in F25 (Scheduling is conceptually a property
OF a Professional per §5). UX: weekly editor (7 days × add/remove interval rows), exception editor (add/
remove date overrides), read-only timezone display, a clear unavailable/empty state (§35). Reuses the
**one** existing Design System (`card`/`btn`/`field`/`table`/`badge`/`empty-state`, confirmed directly in
`app/globals.css`) — no new visual language.

**Challenged assumption, per the brief's own instruction not to accept its framing blindly**: the brief's
§4 asks to inspect "TanStack Query conventions." Inspected directly — `na-pista-console/package.json` has
**no** `@tanstack/react-query` (or any React Query package) installed anywhere; the actual, consistently used
convention across every existing page (Products/Customers/Orders/Services/Professionals) is plain
`useState`/`useEffect` + a manual `load()` function. F26's future UI blueprint follows this **real**
convention, not the brief's inaccurate premise about the current codebase.

## 39. UL Platform impact

- New Platform endpoint? **No.**
- New Platform table? **No.**
- New entitlement? **No** — reuses `catalog.enabled` (§29).
- Changes to Organization? **No.**
- Timezone data needed from Platform? **No.**
- Can Na Pista own tenant-specific timezone configuration instead? **Yes — and does** (§9, ADR-040).
- Any Platform change genuinely cross-application? **No candidate identified.**

**Default posture (no Platform production changes) followed cleanly — zero exceptions found.** No Platform
gap to document.

## 40. ADRs created

- [ADR-039 — Scheduling Domain Model](adr/ADR-039-scheduling-domain-model.md)
- [ADR-040 — Time, Timezone & Availability Semantics](adr/ADR-040-time-timezone-availability-semantics.md)
- [ADR-041 — Scheduling / Appointment Boundary](adr/ADR-041-scheduling-appointment-boundary.md)

Exactly the three the brief's own §7 asks for at minimum — buffer/location/capacity decisions (D11/D20/D21/
D22) are each small enough (a deferral with a one-paragraph additive path) to live inside ADR-039/040/041
rather than justify their own document, matching this project's "do not inflate ADR count for cosmetic
reasons" convention (already applied identically in F24A/F25A).

## 41. Alternatives rejected

Full reasoning lives in each ADR's own "Alternatives" section. Highest-signal ones:
1. **Service-centric or pair-centric availability** — rejected; no demonstrated need, multiplies
   configuration with no consumer — ADR-039.
2. **A single JSON/array `weeklySchedule` column** — rejected; breaks the established "rows, not arrays"
   convention, can't be DB-constrained — ADR-039.
3. **Pre-generated discrete availability slots** — rejected; duplicates derivable data, needs continuous
   invalidation — ADR-039/040.
4. **A dedicated `Break` entity** — rejected; interval composition already suffices — ADR-039.
5. **Exceptions as an additive/subtractive patch** — rejected; ambiguous merge semantics vs. deterministic
   full-replacement-per-date — ADR-039.
6. **`ACTIVE|ARCHIVED` status on the schedule or individual rules** — rejected; duplicates `Professional.
   status`, contradicts `professional_services`'s own physical-delete precedent for configuration-shaped
   tables — ADR-039.
7. **Organization-level opening hours, Locations, Resources in F26** — all rejected; no demonstrated need,
   each has a documented additive path — ADR-039.
8. **Deriving timezone from server or browser** — both rejected; explicitly forbidden by the brief and wrong
   the instant infrastructure/device timezone differs from the tenant's — ADR-040.
9. **`timestamptz`-anchored recurring rule times** — rejected; conflates policy with a frozen instant — ADR-040.
10. **A full custom DST engine now** — rejected; over-engineering, zero near-term benefit — ADR-040.
11. **A new UL Platform `TenantSettings` table for timezone** — rejected; no other product has a demonstrated
    need; violates decision-discipline ordering — ADR-040.
12. **Letting Scheduling store `customerId`/booking state "just in case"** — rejected; the exact anti-pattern
    the Scheduling/Appointment boundary exists to prevent — ADR-041.
13. **Computing bookable (not just working) availability in F26** — rejected; only meaningful once conflicts
    exist to subtract, risks the TOCTOU trap the concurrency invariant warns against — ADR-041.
14. **Freezing F27's Appointment schema or its exact conflict mechanism now** — rejected; not this phase's
    job, same restraint ADR-035/ADR-038 already showed — ADR-041.

## 42. F26 implementation blueprint

**Backend:**
- Schema: `professional_schedule_rules`, `professional_schedule_exceptions` (ADR-039), `organization_settings`
  (ADR-040) — new migration, following the exact same composite-FK-ordering care every prior migration in
  this project has needed (drizzle-kit's recurring FK-before-index bug, manually reordered each time).
- Repository: tenant-scoped, `assertTenant` guard on every function, mirroring `professionals/repository.ts`
  exactly in shape.
- Domain service: weekly-rule whole-set replacement (transactional delete+insert), individual exception
  create/delete, and a pure, independently-testable **availability computation function** (no DB access
  inside it — takes rules/exceptions/timezone/range as plain input, returns working intervals) so its
  overlap/precedence/DST logic can be unit-tested exhaustively without a database.
- Validators: Zod schemas for `dayOfWeek` (0-6), `HH:mm` time strings, IANA timezone (via
  `Intl.supportedValuesOf`), date-range bounds (§36).
- API: routes per §27, mounted the same way `professionalsRouter`/`servicesRouter` are.
- Permissions: `scheduling.read/create/update` added to `ROLE_PERMISSIONS` (§28).
- Entitlement: `catalog.enabled`, reused via the existing `requireCapability` middleware, unchanged.
- Audit: `schedule.updated`/`schedule.exception.created`/`schedule.exception.removed`, same transactional
  `recordAuditEvent` pattern.
- Usage: `api_requests` on the two write actions above (§31).
- Tenant isolation: composite FKs + repository guard (§32), proven with a real cross-tenant FK-violation test
  (same pattern F25's `professional_services` test used).
- Availability computation: the pure function above, exercised by both unit tests (no DB) and integration
  tests (real rows).
- Tests: see §43.

**Console:**
- Extend the existing Professional detail page with a "Horário" section (§38) — no new route.
- A weekly-schedule editor component (7 days × add/remove interval rows, client-side overlap/zero-length
  validation mirroring the server's).
- An exception editor (add/remove date overrides, closed-vs-specific-hours toggle).
- Read-only timezone display (sourced from a small Organization-settings read — the exact UI for *setting*
  it is a small, separate concern F26 must resolve, e.g. a first-run prompt or a minimal settings page, not
  fully specified here since it depends on whether an Organization-settings surface already exists by then).
- Loading/error/empty states matching every existing page's pattern exactly (`A carregar…`, `empty-state`
  card, `ErrorBanner`-shaped error handling).
- Permission-aware rendering via `roleCan(roleKey, "scheduling.update")`, same pattern as every existing page.
- Data fetching: plain `useState`/`useEffect` + `load()`, matching the **actual** existing convention (§38),
  not TanStack Query.
- Component tests: Vitest + React Testing Library, the pattern F25 just established — covering weekly editor
  rendering/interval add-remove, exception editor, timezone display, permission-gated controls, API errors,
  empty schedule, archived Professional.

## 43. F26 test strategy (designed, not implemented)

**Unit:** interval validation (zero-length, overlap, malformed time strings), weekly-rule composition,
exception precedence (replaces vs. no-exception-falls-back-to-weekly), timezone conversion via the pure
availability function, DST edge cases (skip-on-gap, first-occurrence-on-ambiguity, mocked/fixed inputs — no
real DST needed to test the *logic*), Service-duration-fit filtering, archived-Professional behavior
(empty/blocked output).

**Integration (real PostgreSQL):** tenant-scoped repository guard, composite-FK tenant safety (a raw
cross-tenant insert rejected, `error.cause.message` inspected — same pattern as F25), whole-week `PUT`
replacement atomicity (old rows gone, new rows present, in one transaction), exception create/delete
persistence, audit-write-failure rollback (a real forced Postgres constraint violation, same pattern as
every prior module), database-failure behavior (503, not 500).

**E2E (real Platform + real Na Pista + real PostgreSQL):** OWNER/ADMIN/MANAGER/STAFF permission behavior
(STAFF read-only, others full read+create+update), tenant isolation (cross-org 403/404, never leaks
existence), entitlement denial (`catalog.enabled` off → 503 then 403), archived-Professional behavior
(schedule mutation blocked or availability reads empty, per §16), Service-association validation in an
availability query (archived/nonexistent/uncompatible Service → correct error), invalid ranges (malformed
`from`/`to`, exceeding max horizon → 400), cross-tenant ids (never leak existence), computed availability
correctness (a real weekly rule + a real exception, read back, matches expectation).

**UI:** weekly-schedule rendering, adding/removing intervals, exception editing, timezone display,
permission-aware controls (STAFF sees read-only), API error handling, empty-schedule state, archived-
Professional state — all via the now-established Vitest + React Testing Library pattern (F25).

**Regression:** the full existing Service/Professional/Product/Customer/Inventory/Order suites (331 tests as
of F25) must remain green, unchanged — Scheduling is purely additive and touches none of their code.

## 44. F27 readiness

**Proven, not assumed:** F27 (Appointment) can be added as a purely additive domain. It will reference
`Organization`, `Customer`, `Professional`, `Service`, consulting `professional_schedule_rules`/
`professional_schedule_exceptions` (read-only) for availability — zero changes required to any of `Service`,
`Professional`, `professional_services`, or the two Scheduling tables themselves. The Appointment schema
itself is **not** frozen here (not this phase's job — ADR-041) — only the minimum future invariants needed to
keep F26 from blocking it: Scheduling has no Customer reference (so Appointment must own that relationship
entirely, unopposed); Scheduling has no booking status (so Appointment must own lifecycle entirely);
conflict enforcement is F27's responsibility at write time, never assumed satisfied by a prior availability
read (the concurrency invariant, ADR-041); initial capacity = 1 per Professional, one Professional and one
Service per Appointment (§21-23) — each with a named additive extension path if a real future requirement
demonstrates otherwise.

## 45. Deferred scope

Per the brief's own non-goals list (§11), none of the following exist or are implied by any decision in this
spike: Appointment, booking, Customer booking, payments, deposits, reminders, WhatsApp/email notifications,
calendar sync (Google/Outlook), rooms/equipment, Locations (unless a real future requirement demonstrates
mandatory need — none does today), branches, classes/group sessions, waitlists, queue management,
attendance/payroll/commissions, recurring appointments, packages/memberships, resource planning, public
booking pages/links, cancellation/no-show policies, scheduling analytics. Also explicitly deferred within
this domain itself: buffers (§14), per-(Professional,Service) availability overrides (§5), Organization-level
opening hours (§24), overnight intervals (§6), STAFF self-editing their own schedule (§28), configurable
booking increment (§13).

## 46. Risks / limitations

1. **Timezone must be set before Scheduling is usable at all** (§9, fail-closed by design) — a real UX
   dependency F26's Console work must resolve (first-run prompt or a minimal settings surface), not yet fully
   specified here.
2. **DST behavior is a documented contract, not yet proven with real code** — Angola has no DST today, so
   this has zero near-term operational risk, but the future implementation must actually delegate to a
   proven library rather than hand-roll the logic, or the documented contract (§11) will not hold.
3. **The exact F27 conflict-enforcement mechanism is not yet selected** (§20) — a real, deliberately open
   question for F27 to resolve with its own full requirements; F26 does not depend on this being resolved,
   but F27 cannot ship without resolving it.
4. **`organization_settings` is a new, minimal table with no prior precedent in this codebase** (a 1:1-with-
   Organization settings table) — small departure worth naming, though it introduces no new architectural
   pattern (still tenant-scoped, still Na-Pista-owned).
5. **The exact IANA-timezone-setting UI/UX is not specified** (§42 Console blueprint notes this as an open
   implementation detail for F26, not a blocking one for F26A).

## 47. Open decisions, if any

None block F26 implementation. The only genuinely open items are explicitly **F27-owned**, not F26-blocking:
the exact conflict-enforcement mechanism (§20/§44), and the exact Appointment schema shape (deliberately not
frozen, per ADR-041's own restraint). Both are named, both have a documented direction, neither requires F26
to make a choice on their behalf.

## 48. Self-review results

See §49 below (the brief's own checklist, `docs/adr/README.md`'s numbering confirmed, and this report's own
structure) — every checkbox in the brief's §19 gate is satisfied:

- **Architecture:** Scheduling has exactly one responsibility (§4/§5); contains no Customer (§19/ADR-041);
  never becomes Appointment (§19); Service remains WHAT, Professional remains WHO, Scheduling remains WHEN
  (§3, unchanged); `professional_services` remains the compatibility relationship, never duplicated (§15);
  `Service.durationMinutes` remains canonical (§12).
- **Time:** canonical timezone ownership defined (§9); server timezone not relied upon (§9); browser
  timezone not authoritative (§9); wall-clock vs. absolute semantics defined (§10); DST behavior documented
  (§11).
- **Schedule model:** weekly rules defined (§6); multiple-intervals/day explicit (§6); overnight-interval
  decision explicit — deferred (§6); break semantics explicit — no entity (§8); exception semantics and
  precedence explicit (§7); empty-schedule semantics explicit (§35); delete/lifecycle semantics explicit
  (§34).
- **Availability:** stored-vs-generated decision explicit (§13); working-vs-bookable explicit (§18);
  duration interaction explicit (§12); slot-increment decision explicit — deferred/policy (§13); buffer
  ownership explicit — deferred, owner named (§14); archived-Professional behavior explicit (§16); Service
  compatibility behavior explicit (§15).
- **Future Appointment:** remains future scope (§19/§44); conflict ownership explicit — F27 (§20);
  availability reads not treated as transactional (§20); write-time revalidation required, documented (§20);
  initial capacity explicit (§21); multi-professional explicit (§22); multi-service explicit (§23); F27 is
  additive (§44).
- **Tenancy:** every persisted record organization-scoped (§32); cross-tenant references prevented (§32);
  repository scoping defined (§32); API non-leakage defined (§32/§33).
- **Authorization:** permissions defined (§28); role behavior defined (§28); entitlement decision explicit —
  reuse `catalog.enabled` (§29); no unjustified Platform entitlement invented (§29/§39).
- **Operations:** audit vocabulary defined (§30); usage behavior defined (§31); query-horizon protection
  defined (§36); error semantics defined (§33); no raw DB errors exposed conceptually (§33).
- **UI:** Na Pista Console confirmed as the official F26 UI (§38); future route defined — extends Professional
  detail page (§38); weekly-editor contract defined (§38/§42); exceptions UX defined (§38/§42); timezone
  visible to users (§38); existing Design System reused (§38).
- **Platform:** impact explicitly assessed (§39); no Platform change proposed without cross-application
  justification — none found (§39).
- **Scope:** no production Scheduling code created; no production migrations created; no Appointment code
  created; no production UI created; no unrelated refactor performed — confirmed by §49's `git status`.

All satisfied. **No architecture-blocking question remains.**

## 49. Git status

Working tree inspected before any change (only F25's already-committed state present) and after all F26A
writes:

```
?? docs/adr/ADR-039-scheduling-domain-model.md
?? docs/adr/ADR-040-time-timezone-availability-semantics.md
?? docs/adr/ADR-041-scheduling-appointment-boundary.md
?? docs/f26a-report.md
 M docs/adr/README.md
```

Only documentation/ADR changes — no schema, migration, route, service, repository, or UI file touched;
confirmed by the same inspection. No secrets committed (no `.env`, no credential, no key referenced anywhere
in these five files). No changes to `na-pista-console` or `ul-platform` in this phase (a pure `na-pista`
documentation spike, no fixtures needed).
