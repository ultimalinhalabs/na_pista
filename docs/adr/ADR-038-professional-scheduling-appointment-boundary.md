# ADR-038 — Professional / Scheduling / Appointment / Auth Boundary

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F25A (spike)

## Context
ADR-035 (F24A) already fixed the four-way conceptual boundary (`Service = WHAT`, `Professional = WHO`,
`Scheduling = WHEN`, `Appointment = the actual booking`). F25A must restate and extend it concretely for
Professional specifically, and close the Auth boundary the F24 report flagged as still open in spirit
(Professional identity vs. Platform identity).

## Decision

**Professional answers exactly one question: "who performs the service?"** It must **never** contain:
- Scheduling-shaped fields: `weeklySchedule`, `workingHours`, `availability`, `blockedTimes`, `vacation`,
  `break`, `calendar`, `appointmentSlots` — all of F26's domain (F18's own SD-3 already sketches
  `WorkingHours`/`TimeOff` as *their own* future entities, never a `Professional` column).
- Appointment-shaped fields: `appointmentId`, `currentAppointment`, `nextAppointment`, `bookingStatus` — all
  of F27's domain. `Professional.status` (`ACTIVE|ARCHIVED`) is a **catalog** membership state, never a
  real-time booking/availability state — restated from ADR-036, the same distinction Service already draws
  between its own catalog `status` and a future booking-time check.

**Auth boundary (F25A brief §25, closing what F24's own report left open):** `Professional` and Platform
`User` are two independent concepts that may *optionally* link, never automatically merge:
```
User/Auth (Platform)
    │
    └── optional, explicit-only future link
         │
         ▼
    Professional (Na Pista)
         │
         └── professional_services
                  │
                  ▼
                Service
```
No `professional.userId` exists in F25A's contract (ADR-036) — this diagram documents the *shape* such a link
would take **if** a real login requirement for Professionals is demonstrated later, explicitly mirroring
`Customer`'s own already-proven pattern (nullable `platformUserId`, linked only by explicit user action, never
by automatic email matching, `domain-model.md` §4) — not a new invention. This is kept **structurally separate**
from the `professional_services` relationship: a future auth link changes nothing about how Professional
relates to Service, and vice versa.

**F26 (Scheduling) readiness:** Scheduling will read `Professional` (to know who has a schedule at all) and
`professional_services` (to know which Services that Professional can be booked for) without any change to
either — it introduces its own new tables (`working_hours`, `time_off`, computed availability, per F18 SD-3)
entirely outside `Professional`'s own schema.

**F27 (Appointment) readiness:** a future Appointment references `Professional`, `Service`, and `Customer`
together. The exact snapshot contract (documented now, not implemented): at Appointment-creation time, a
future "booked professional" record snapshots `professionalId` and `professionalName` — the same historical-
integrity principle ADR-031/ADR-034 already established for `OrderItem`/the future `AppointmentService`
(a later Professional rename must not alter a past Appointment's record). Appointment creation must validate,
at booking time, that the chosen `(professionalId, serviceId)` pair is a real row in `professional_services`
(i.e., that professional is actually configured to perform that service) — a rule F27 enforces, not F25;
`professional_services`'s existence is exactly what makes that future check possible without inventing
anything new at that point.

## Alternatives

**A `Professional.availableFrom`/`availableTo` pair "just to have something"** — rejected; this is exactly the
scheduling-shaped field the brief and ADR-035 both rule out, and nothing in F25's own scope needs it.

**Collapsing the auth link into `professional_services` (e.g., a `userId` column on the join table)** —
rejected: conflates two orthogonal relationships (who a professional *is* vs. what they *can perform*) for no
benefit; keeping them structurally separate (per the diagram above) means either can evolve independently.

**Deciding F26/F27's own internal schemas now "to save time later"** — rejected; F25A's job is the boundary
and the readiness guarantee, not pre-designing phases that have not themselves gathered their own
requirements yet (the same restraint ADR-035 already showed toward F26/F27 in F24A).

## Consequences
- (+) F26 can be designed and built without ever touching `professionals` or `professional_services`.
- (+) F27 can be designed and built the same way — both are purely additive consumers.
- (+) If Professionals never need login at all, nothing about this model is wasted or needs to be reverted —
  the auth link was never assumed, only left as a documented option.
- (−) F25 alone cannot yet express "this professional is currently on vacation" or "this professional has 3
  upcoming appointments" — both real, deliberately deferred limitations, not oversights.

## Future extension path
F26 introduces its own scheduling tables reading `Professional`/`professional_services` unchanged. F27
introduces `appointments` (+ its own snapshot shape) referencing `Professional`/`Service`/`Customer` unchanged.
A `platformUserId` on `Professional`, additive, the moment a real requirement demonstrates it.
