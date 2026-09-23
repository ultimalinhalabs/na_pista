# ADR-040 — Time, Timezone & Availability Semantics

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F26A (spike)

## Context

F18's `domain-model.md` SD-3 assumed `TenantSettings.timezone` would exist "obrigatório antes de haver
marcações." **This was inspected directly, not assumed: no `TenantSettings` table exists anywhere in
`ul-platform`, and `organizations` (`ul-platform/src/db/schema/organizations.ts`) has exactly `id, name,
slug, createdBy, createdAt, updatedAt` — no timezone, no locale field.** `profiles.locale` exists but is a
per-*user* field, not per-Organization, and is unrelated. This ADR closes the resulting open question:
F26A must decide, from scratch, where timezone lives and how wall-clock vs. absolute time are represented.

## Decision

**Timezone is owned by Na Pista, not UL Platform.** A new table, in Na Pista's own schema:

```
organization_settings {
  organizationId   -- PK, no separate surrogate id needed (1:1 with Organization)
  timezone         -- text, IANA identifier, e.g. "Africa/Luanda"
  createdAt
  updatedAt
}
```

**Why Na Pista, not a UL Platform change to `organizations`:** timezone is, right now, a Na-Pista-Scheduling-
specific operational need — nothing else in Na Pista needs it (Product/Customer/Order/Inventory all only
ever record `timestamptz`, which is UTC-absolute and timezone-*display*-agnostic). No other UL Platform
product (Micha Express, Foi, Qualé a Dica) has a demonstrated cross-application need for organization
timezone today. Adding it to UL Platform's shared `organizations` table would create new shared-infrastructure
surface for a single current consumer — the CLAUDE.md repository-boundary rule keeps business-domain concerns
in the product, and the project's own decision-discipline order (§14: simplicity before premature
generalization) argues against promoting this to Platform speculatively. **If a second UL product later
needs organization timezone too, that is the trigger to promote it — not now.**

**API representation:** an IANA timezone identifier string (`"Africa/Luanda"`), never a raw UTC offset —
offsets are not stable identity (they change under DST, are ambiguous during transitions, and carry no
policy information); IANA identifiers are the correct long-term identity, exactly as the brief requires.
Validated against Node's own `Intl.supportedValuesOf("timeZone")` at the Zod schema layer — no external
timezone-database dependency needed for validation.

**DB representation:** a plain `text` column. Postgres has no native IANA-timezone type; storing the
identifier string is the standard, portable approach (the same approach every mainstream scheduling
library/ecosystem — Temporal, date-fns-tz, Luxon — expects as input).

**No silent fallback (fail-closed, matching ADR-017).** Until an organization has an explicit timezone set,
Scheduling refuses to compute availability rather than silently defaulting to UTC, the server's own
timezone, or a browser's timezone — all three are explicitly forbidden by the brief and would each produce
wrong, unpredictable working hours. A sensible **UX default** of `Africa/Luanda` may be *offered* at
first-schedule-setup time in the Console (an explicit user choice to accept or change), which is a UI
convenience decision for F26, not a silent runtime fallback — the two must not be conflated.

**Future multi-location implication:** if/when Location is introduced (deferred, ADR-039), timezone
ownership can move to Location as an override of the Organization-level default, without redesigning this
table — `organization_settings.timezone` simply becomes "the org-wide default when a Location doesn't
specify its own."

---

**Wall-clock local time vs. absolute timestamp — explicit distinction (D7):**

| Data | Type | Meaning |
|---|---|---|
| `professional_schedule_rules.startLocalTime`/`endLocalTime` | Postgres `TIME` | Wall-clock local time, re-resolved against the Organization's *current* timezone at read/compute time — "every Monday at 08:00" means 08:00 in whatever the org's timezone currently is, not a frozen UTC instant. |
| `professional_schedule_exceptions.date` | Postgres `DATE` | A calendar date in the Organization's own calendar — "December 25th," not a UTC-anchored date. |
| `professional_schedule_exceptions.startLocalTime`/`endLocalTime` | Postgres `TIME`, nullable | Same wall-clock interpretation as rules. |
| Future `Appointment` start/end (F27, not built) | Postgres `timestamptz` | An absolute, unambiguous instant — exactly like every other timestamp already in this codebase (`createdAt`/`updatedAt`, Order timestamps). |

This is the correct semantic split: a recurring rule describes a *policy* ("the shop opens at 8am, every
Monday, indefinitely"), not a frozen instant; an Appointment describes one *specific real-world moment*.
Conflating the two — e.g. storing `startLocalTime` as a `timestamptz` anchored to some arbitrary reference
date — would be wrong the moment DST or a timezone correction is involved.

**API payload representation:** local wall-clock times as plain `"HH:mm"` strings (24h, no timezone suffix,
no `Z`) for schedule rules/exceptions — attaching a UTC offset here would misleadingly imply an absolute
instant. Exception dates as plain `"YYYY-MM-DD"`. Future Appointment timestamps use full ISO-8601
`timestamptz` strings (`"2026-09-28T07:00:00Z"`), matching Order's already-established convention exactly.

---

**DST behavior (D8) — documented expectation for the future implementation, not built now:**
- A **nonexistent local time** (a "spring forward" gap): the future availability-computation algorithm skips
  that specific date's occurrence of the affected rule rather than crash or silently shift it — the same
  normalization every mainstream date/timezone library already performs; Na Pista does not invent its own
  DST math, it delegates to a proven library (Temporal, date-fns-tz, or Luxon — the exact library is an F26
  implementation detail, not decided here) and documents the *expected behavior contract* only.
- A **repeated local time** (a "fall back" ambiguity): treated as its first occurrence (the earlier UTC
  instant), by the same delegated-library convention.
- Angola has no DST today, so this has zero near-term operational impact — but the architecture must not
  silently assume it never will, given Na Pista's stated multi-tenant SaaS ambitions. Explicitly **not**
  building a custom timezone engine now — this section exists so a future implementer has a deterministic
  contract to satisfy, not a blank page.

---

**Availability computation (D14) — working vs. bookable, and the responsibility boundary:**

- **Working availability** (F26 owns this, fully): raw open time intervals for a Professional, derived from
  `professional_schedule_rules` ± `professional_schedule_exceptions` (ADR-039) for a requested date range,
  optionally narrowed by a `serviceId`'s `Service.durationMinutes` + `professional_services` compatibility
  (below). Answers "when could this professional conceivably work" — with zero knowledge of any actual
  booking.
- **Bookable availability** (F27's, not F26's, because Appointment doesn't exist yet): working availability
  minus existing Appointment conflicts (and, later, buffers). F26's availability endpoint returns **working**
  availability only, and must be named/labeled unambiguously as such in the future API contract (ADR-039/
  D23) — never presented in a way that implies "this is guaranteed bookable," to prevent client code (Console
  or any future integration) from treating a `GET` response as a booking guarantee (see ADR-041's
  concurrency invariant).
- Conceptual formula (documented, not built): `bookable = working ± exceptions − appointment conflicts −
  buffers`. F26 delivers everything left of "− appointment conflicts."

**`Service.durationMinutes` interaction (D9) — remains the one canonical duration, never duplicated:**
Scheduling never stores duration anywhere. When an availability query includes `serviceId`, the future
implementation reads `Service.durationMinutes` live (via the existing `services` repository — the same
cross-module read pattern `professional_services`'s association logic already uses) and cross-checks
`professional_services` for compatibility. This directly answers the brief's own D9 question ("does
Scheduling duplicate duration?") — **no.**

**Slot granularity (D10) — continuous ranges stored, slots derived, never pre-generated:** validates and
keeps F18 SD-3's original "computed, never stored" reasoning (not just inherited blindly — pre-generated
slots would require continuous regeneration/invalidation on every rule/exception change and duplicate
trivially-derivable data). Three distinct "granularity" concepts, explicitly not conflated:
- *Booking increment* (how often a valid start time can occur, e.g. every 15 minutes) — a configurable
  **policy**, not a stored data concept; F26A defers whether this becomes per-organization-configurable
  (no proven requirement yet) — a fixed, documented implementation-time constant is sufficient if F26 needs
  one at all.
- *UI display increment* — purely a Console concern, not a backend data concept.
- *Generated slot duration* — derived directly from `Service.durationMinutes`, never separately stored.

F26A makes an explicit F26/F27 split here: **F26 may return raw working intervals, optionally filtered by
"does this interval even fit the service's duration" — it does not need to compute precise bookable start
times**, because that computation is only meaningful once conflicts (F27/Appointment) can be subtracted;
computing exact start times against a domain that has no conflicts yet has limited real value and would be
redone once Appointment exists anyway.

**Buffer time (D11) — deferred again, F24A's deferral carried forward, with a concrete future owner named:**
No demonstrated requirement for F26/F27's initial scope. If ever added, `bufferBefore`/`bufferAfter` belong
on **`professional_services`** (the association row), not `Service` (buffer is often professional-specific —
a senior vs. junior barber may need different cleanup time for the same service) and not `Professional`
(buffer is often service-specific — a haircut vs. a shave differ). `professional_services` already exists as
its own row (ADR-037) precisely because it's the natural join point for exactly this kind of pair-specific
attribute later — purely additive (two nullable integer columns), zero redesign of any relationship. Buffers,
once added, act only inside F27's bookable-availability computation, never touching `professional_schedule_
rules`/`professional_schedule_exceptions` at all.

**Professional-Service compatibility (D12) — combined only at query time, never duplicated:** a future
availability-for-booking read = stored schedule rules/exceptions (ADR-039) ∩ `professional_services`
compatibility (row exists, both `ACTIVE`) ∩ `Service.durationMinutes` [∩ future Appointment conflicts, F27].
Neither Scheduling table references `serviceId` at all (confirmed directly in ADR-039's schema) — Scheduling
never re-implements or duplicates the N:M relationship `professional_services` already owns.

## Alternatives

**Deriving timezone from the server's own timezone** — rejected; explicitly forbidden by the brief, and
wrong the moment Na Pista runs on infrastructure in a different timezone than any tenant.

**Deriving timezone from the browser** — rejected; explicitly forbidden by the brief, wrong the moment
someone manages a schedule from a device set to a different timezone than the business itself.

**Storing recurring rule times as `timestamptz` anchored to an arbitrary reference date** — rejected;
conflates a recurring policy with a frozen instant, breaks the moment DST or a timezone correction applies.

**Building a full custom DST/timezone engine now** — rejected (D8); over-engineering with zero near-term
benefit (Angola has no DST); a documented behavior contract plus a proven library at implementation time is
sufficient.

**Pre-generated slot storage** — rejected (D10), see "Consequences" in ADR-039; same reasoning restated here
for the specific slot-granularity question.

**A UL Platform `TenantSettings` table added now to hold timezone** — rejected; no other product has a
demonstrated need, and inventing shared Platform infrastructure for one consumer violates the project's own
decision-discipline ordering (simplicity/no premature generalization). Explicitly documented as a **non-
change** to UL Platform (see F26A report §39 "UL Platform impact").

## Consequences

- (+) Na Pista can ship organization-timezone configuration entirely within its own schema/migrations —
  zero coordination with or change to UL Platform.
- (+) Wall-clock recurring rules and absolute Appointment timestamps are structurally distinct types from
  day one — no future migration needed to "fix" a conflated representation.
- (+) DST has a documented, deterministic contract before any code exists, preventing an implementer from
  inventing ad-hoc behavior under time pressure later.
- (−) Until an organization explicitly sets a timezone, Scheduling cannot compute anything — a real,
  deliberate fail-closed limitation, not an oversight; the Console must make setting it an unavoidable part
  of first-time schedule setup (an F26 UX requirement, not decided in schema terms here).

## Future extension path

If a second UL Platform product later needs organization timezone, promoting `organization_settings.
timezone`'s *concept* to a Platform-level `Organization` field becomes a real, evaluable decision at that
point — Na Pista's own `organization_settings` table would not need to be deleted immediately; it could
simply stop being the source of truth, read-through to Platform instead, an additive migration path, not a
redesign forced under this ADR's decision.
