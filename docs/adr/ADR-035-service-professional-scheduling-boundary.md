# ADR-035 — Service / Professional / Scheduling / Appointment Boundary

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F24A (spike)

## Context
F18's `domain-model.md` SD-1 already anticipated a `Service ↔ Professional` N:M relationship
("`ProfessionalService`") and SD-3/SD-4/SD-5 sketched Scheduling/Appointment conceptually. F24A must decide
exactly where F24's Service catalog stops and each future module (F25 Professionals, F26 Scheduling, F27
Appointments) begins — without building any of them now (F24 brief §0/§4's explicit exclusions).

## Decision

**Four explicit, non-collapsing boundaries** (F24 brief §27's own framing, adopted verbatim):
```
Service        → WHAT is being performed        (F24 — this phase)
Professional   → WHO performs it                (F25 — not built)
Scheduling     → WHEN it can be performed        (F26 — not built)
Appointment    → WHO booked WHAT, with WHOM, WHEN (F27 — not built)
```

**Service has zero reference to Professional in F24.** No `professionalId` column, no FK, nothing. Not every
Service necessarily requires a Professional at all (F24 brief §19's own example: an "automated"/self-service
offering) — F24A found no universal invariant forcing one, so none is assumed. This keeps `Service` fully
buildable and testable in F24 with no dependency on F25 existing yet.

**The future `Service ↔ Professional` relationship (F25) is a separate join table, additive, not a change to
Service:**
```
professional_services {
  id
  organizationId
  professionalId   -- FK, composite (organizationId, professionalId) -> professionals(organizationId, id)
  serviceId        -- FK, composite (organizationId, serviceId) -> services(organizationId, id)
}
```
Same composite-FK, tenant-safe pattern ADR-021 already proved for `products → categories` and ADR-031/F23 for
`order_items → products`. **Not created now** — `professionals` does not exist yet, there is nothing to
reference. F25 owns creating this table; it requires no migration or redesign of `Service` when it happens
(purely additive — a new table pointing at an existing one).

**Scheduling (F26) consumes exactly one Service field: `durationMinutes`.** The expected future flow (F24
brief §41, restated as this ADR's decision): `Service.durationMinutes = 60` → Scheduling computes
`start = 10:00, end = 11:00` for a specific Professional's calendar. **`Service` never stores `startTime`/
`endTime`** — a Service is a catalog definition, never a calendar event, exactly per the brief's own
instruction. `WorkingHours`/`TimeOff`/computed availability (F18 SD-3) are entirely Professional/Scheduling's
domain, untouched by F24.

**Appointment (F27) boundary:** `Appointment` will reference `Service`, `Professional`, and `Customer`
together — none of which reference each other directly today. The exact snapshot fields Appointment consumes
from Service (`id`, `serviceName`, `unitPrice`, `durationMinutes`, and a status check at booking time to
reject archived Services) are specified in ADR-034 "Future price/duration snapshot contract." Per F18 SD-5,
"uma marcação = um serviço" (one Appointment = one Service) remains the v1 assumption — multi-service
Appointments stay OD-09, unchanged by this phase.

**Archived Service behavior (restated concretely for the future consumers above):** readable for history
(an existing Appointment referencing an archived Service remains fully valid and displayable — exactly
Product/ADR-020's posture, extended); **not** selectable for a *new* Appointment once F27 exists (mirrors
`ProductArchivedError`'s exact posture for Orders, ADR-031/F23); not shown in the default active-catalog list
(`status=ACTIVE` filter, matching every other module); never physically deleted.

## Alternatives

**Adding `Service.professionalId` (single professional per service) now** — rejected: contradicts the
brief's own worked example (a service performed by *several* professionals, e.g. "Haircut → Barber A, Barber
B") and forecloses the N:M shape SD-1 already anticipated, for no benefit (nothing consumes this field until
F25 exists).

**Building `professional_services` now, with `professionals` as a stub table** — rejected: F24A is explicitly
told not to implement Professionals in any form (brief §4); a stub table is still a production table this
phase must not create, and it would need real columns before F25 could use it anyway — better decided
properly, as its own phase.

**Storing buffer/prep time or a booking grid on Service** — rejected; see ADR-034.

**Collapsing Service and Appointment into one entity ("a Service IS what gets booked")** — rejected: this is
exactly the anti-pattern the brief warns against (§27: "Do not collapse these domains"). A catalog entry must
outlive and be reusable across many bookings; a booking is a specific instance in time. Conflating them would
make archiving a Service (a catalog action) inseparable from canceling every Appointment that ever referenced
it (a booking action) — the same reasoning that already separates `Product` from `OrderItem`.

## Consequences
- (+) F25 can implement Professionals, F26 can implement Scheduling, and F27 can implement Appointments —
  each independently — without any of them requiring a redesign of `Service` (brief §47 self-review items
  30-32, answered "yes" with this reasoning).
- (+) `Service` stays testable and shippable in F24 in complete isolation, exactly like `Product` was in F20
  before `Customer`/`Inventory`/`Orders` existed.
- (−) F24's Service catalog cannot yet express "this service is only offered by these professionals" — a
  real, deliberate limitation until F25 exists, not an oversight.

## Future extension path
F25: `professionals` table + `professional_services` join table (composite-FK both sides, per above) — zero
changes to `services`. F26: reads `Service.durationMinutes` + Professional's availability; introduces its own
tables (`working_hours`, `time_off`, possibly an exclusion constraint per SD-4) — zero changes to `services`.
F27: `appointments` (+ a service-snapshot shape per ADR-034) referencing `Service`/`Professional`/`Customer` —
zero changes to `services`' own schema, only new FKs pointing at it.
