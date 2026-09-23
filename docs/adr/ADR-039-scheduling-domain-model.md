# ADR-039 — Scheduling Domain Model

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F26A (spike)

## Context

ADR-035/ADR-038 already fixed the four-way boundary (`Service = WHAT`, `Professional = WHO`,
`Scheduling = WHEN`, `Appointment = the actual booking`) and F18's `domain-model.md` SD-3 sketched
`WorkingHours`/`TimeOff` with computed (never stored) availability. F26A must turn that sketch into a
concrete, tenant-safe model — validated against the real, current `professionals`/`services`/
`professional_services` schema (inspected directly, not assumed) — without redesigning any of the three.

## Decision

**Scheduling is two small, additive tables, both owned by Professional (not Service, not the
Professional-Service pair):**

```
professional_schedule_rules {
  id
  organizationId
  professionalId        -- composite FK (organizationId, professionalId) -> professionals(organizationId, id)
  dayOfWeek              -- 0-6
  startLocalTime         -- TIME, wall-clock, no timezone attached at the row
  endLocalTime           -- TIME, endLocalTime > startLocalTime, same calendar day
  createdAt
  updatedAt
}

professional_schedule_exceptions {
  id
  organizationId
  professionalId         -- composite FK (organizationId, professionalId) -> professionals(organizationId, id)
  date                   -- DATE, the organization's own calendar date
  startLocalTime         -- TIME, nullable
  endLocalTime           -- TIME, nullable
  createdAt
}
```

**Professional-centric, not Service-centric (D2).** A Professional has exactly one working-hours
configuration, independent of which Services they perform — `professional_services` already answers "can
this Professional do this Service"; Scheduling answers "is this Professional working at all right now,"
a strictly orthogonal fact. Neither table references `serviceId`. A per-(Professional, Service) override
(e.g., "only available for haircuts on Tuesdays") has no demonstrated requirement and is rejected for F26,
with a documented additive path (a separate override table, if ever needed, would not touch these two).

**Rows, not arrays or JSON (D3/D4).** One row per interval, matching the exact convention `order_items`/
`professional_services` already established in this codebase — never a single day serialized as an array
column. Multiple intervals per day = multiple rows sharing the same `dayOfWeek`. This is how a lunch break
is represented (D5): `08:00–12:00` + `13:00–17:00`, two rows, **no dedicated Break entity** — interval
composition is sufficient, exactly as F26A brief §D5 itself suggests as the preferred outcome.

**Closed days = zero rows (D3).** No explicit `isClosed` flag on a day — the absence of any rule row for a
`dayOfWeek` means that day is closed. Consistent with D33 below (empty = unavailable, fail-closed).

**Overlapping or zero-length intervals within the same day are rejected at write time (D3)** — a
`ValidationError` (400), detectable from the request body alone, no DB state needed. **Overnight intervals
(`22:00 → 02:00`) are NOT supported in F26** — `endLocalTime` must be strictly greater than `startLocalTime`
within the same calendar day. Deferred, not forbidden forever: no current Na Pista use case (barbershop/
personal-service SMB) demonstrates an overnight shift, and building the "which day does this interval
really belong to" semantics now would be speculative complexity with no consumer. Documented additive
extension path: a `spansMidnight` boolean, or splitting an overnight shift into two same-day rows at write
time, whichever a real future requirement turns out to need — no redesign of this table either way.

**Exceptions can both ADD and REMOVE availability, via one mechanism (D4).** For any `date` that has at
least one exception row, that row set **completely replaces** the weekly rule for that date — the weekly
rule is not consulted at all once an exception exists. Two row shapes:
- One or more rows with non-null `startLocalTime`/`endLocalTime` = "available these specific intervals on
  this date" (can open a normally-closed Sunday, or narrow/widen a normally-open day).
- Exactly one row with **both** `startLocalTime`/`endLocalTime` NULL = an explicit "fully unavailable this
  date" marker (closes an otherwise-open day, e.g. 2026-12-25). A `CHECK` constraint enforces the closed-
  marker row is unique per `(organizationId, professionalId, date)` and cannot coexist with interval rows
  for the same date.

This gives deterministic precedence with no merge ambiguity: **exception (if any exists for a date) wins
entirely over the weekly rule for that date** — never a partial overlay, never "add exception intervals to
the weekly ones." Simple to validate, simple to reason about, simple to test.

**Scheduling rules are configuration, not a business/historical record — physical `DELETE`, not archive
(D32).** Unlike Professional/Service/Product/Customer (entities whose *identity* is worth preserving), a
schedule rule is closer to `professional_services` in kind (ADR-037 already established physical delete for
that relationship/configuration-shaped table) than to Professional itself. The weekly rule set is replaced
as a whole (`PUT`, D23) on every edit — old rows are deleted, new ones inserted, in one transaction; a single
exception is created/deleted individually by id, never edited in place (no `PATCH` on an exception — delete
and recreate instead).

**No separate Schedule lifecycle/status (D31).** A Professional always conceptually *has* a schedule — it
may simply have zero rules right now. Introducing `ACTIVE|ARCHIVED` on the schedule itself would duplicate
`Professional.status` for no benefit: an archived Professional's schedule already cannot be booked
regardless of what its rules say (see "Archived entities" below).

**Empty schedule = unavailable, always (D33).** Zero rules and zero exceptions for a Professional means
`UNAVAILABLE`, full stop — fail-closed, matching ADR-017's established project-wide posture. Explicitly
rejected: "unrestricted" (a brand-new Professional would wrongly appear bookable 24/7) and "inherit
organization schedule" (rejected — no Organization-level schedule exists to inherit from, see "Organization
hours" below).

**Archived-entity behavior (D13), extending the exact pattern `professional_services` already uses for
archived Professionals/Services (ADR-037):**
- Archiving a Professional **never deletes** its schedule rules/exceptions — historical preservation, same
  posture as every other archive operation in this codebase.
- An archived Professional's computed availability must read as unavailable/empty (or a specific
  "professional is archived" response) — the underlying rows are untouched, but nothing should present them
  as live availability while archived.
- Reactivating a Professional restores prior availability automatically, for free — nothing was ever
  deleted, so there is no separate "restore" mechanism to build.
- Archiving a Service has **zero effect** on any Professional's stored schedule (Service-agnostic per
  Professional-centric ownership above) — but a `serviceId`-filtered availability query against an archived
  Service fails the compatibility check at query time (mirrors `ServiceArchivedError`'s existing posture),
  not because Scheduling stores anything about the Service.
- Removing a `professional_services` association destroys **no** Scheduling data — a Professional's general
  working hours are unaffected by which Services they're currently configured to perform.

## Alternatives

**Service-centric or Professional-Service-pair-centric availability** — rejected (D2): no demonstrated
requirement, and multiplies schedule configuration by professional × service with no current consumer;
documented as an additive future override layer if a real need ever appears.

**A single `weeklySchedule` JSON/array column on `professionals`** — rejected: breaks this codebase's
established "rows, not arrays" convention, cannot be individually constrained/validated at the DB level
(overlap/zero-length checks), and cannot be queried/joined the way the rest of this domain relies on.

**Pre-generating and storing discrete availability slots** — rejected (D10, restated in ADR-040): would
duplicate data derivable from the rules/exceptions above and require continuous invalidation on every rule
change; F18's own SD-3 "computed, never stored" reasoning holds up under inspection and is kept, not just
inherited blindly.

**A `Break` entity separate from working intervals** — rejected (D5): interval composition
(`08:00–12:00` + `13:00–17:00`) already expresses it with zero new concepts.

**Exceptions as an additive/subtractive patch over the weekly rule** — rejected (D4): ambiguous merge
semantics (does an exception interval get unioned or intersected with the weekly rule for that date?);
full-replacement-per-date is simpler and fully deterministic.

**`ACTIVE|ARCHIVED` status on the schedule or on individual rules** — rejected (D31/D32): duplicates
`Professional.status` with no independent meaning; rules are physically deleted/replaced instead, matching
`professional_services`'s own precedent for configuration-shaped tables.

**Organization-level opening hours in F26** — rejected (D20): no demonstrated need; a Professional's own
schedule already fully expresses "closed" (zero rules) without a separate ceiling concept. Documented as an
additive future intersection layer if ever required.

**Locations/branches or generic Resources in F26** — rejected (D21/D22): no proven requirement for the
initial Angola SMB use case; both have documented additive extension paths (an optional `locationId` on
`professional_schedule_rules` later; a `resource_services`-shaped table mirroring `professional_services`)
that require zero redesign of the model decided here.

## Consequences

- (+) Scheduling introduces two new tables, zero changes to `professionals`/`services`/`professional_services`
  — F26 can be built as a pure additive consumer, exactly as ADR-035/ADR-038 promised.
- (+) Deterministic, testable semantics for overlap/precedence/empty-state, with no merge ambiguity to get
  wrong.
- (+) The exact same tenant-safety mechanism (`organizationId` + composite FK back to `professionals`) this
  codebase has proven four times (`products→categories`, `order_items→products`, `professional_services→
  professionals/services`) is reused unchanged, not reinvented.
- (−) F26 cannot yet express per-(Professional, Service) availability differences, Organization-level
  opening hours, Locations, or Resources — all real, deliberately deferred limitations with documented
  additive paths, not oversights.

## Future extension path

F27 (Appointment) reads these two tables plus `professional_services` plus `Service.durationMinutes` to
compute bookable availability and enforce write-time conflicts — zero changes to either table here (see
ADR-041). A per-(Professional, Service) override, Organization-level hours, Location, buffers, and capacity
each have a named, additive extension path documented above and in ADR-040/ADR-041 — none requires
redesigning `professional_schedule_rules`/`professional_schedule_exceptions`.
