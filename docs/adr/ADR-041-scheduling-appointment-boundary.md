# ADR-041 — Scheduling / Appointment Boundary

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F26A (spike)

## Context

ADR-035/ADR-038 already named the boundary conceptually; ADR-039/ADR-040 now give Scheduling a concrete
model. This ADR closes the remaining question the brief treats as make-or-break (D15-D19): exactly where
Scheduling's responsibility ends and Appointment's (F27, not built) begins, including the concurrency
invariant that must hold even though F27 is not implemented yet.

## Decision

**Scheduling answers "when CAN this Professional work?" Appointment (future) answers "what HAS BEEN / WILL
BE booked?"** Ownership split, explicit and exhaustive:

| Concern | Owner |
|---|---|
| Recurring weekly working intervals | Scheduling (`professional_schedule_rules`) |
| Date-specific overrides | Scheduling (`professional_schedule_exceptions`) |
| Computed *working* availability | Scheduling |
| Booking status (e.g. SCHEDULED/COMPLETED/CANCELED) | Appointment (F27) |
| Customer reference | Appointment (F27) — **Scheduling contains zero Customer reference, ever** |
| Service snapshot (name/duration/price at booking time) | Appointment (F27), mirroring `OrderItem`'s exact
  historical-snapshot pattern (ADR-031/ADR-034) |
| Professional reference/snapshot | Appointment (F27) |
| Start/end timestamp (absolute, `timestamptz`) | Appointment (F27) |
| Cancellation | Appointment (F27) — a status transition, never a DELETE, mirroring Order's own cancellation
  posture (ADR-032) |
| Conflict/reservation locking | Appointment (F27) — see concurrency invariant below |
| Computed *bookable* availability (working minus conflicts) | Appointment (F27), consuming Scheduling as a
  read-only input |

**Scheduling must never become a reservation system.** It has no concept of "this slot is taken" — only "is
the Professional generally working at this wall-clock time." The moment Scheduling started tracking booking
state, it would have silently absorbed Appointment's responsibility, exactly the anti-pattern ADR-035
already warned against for Service/Appointment ("do not collapse these domains").

---

**Concurrency invariant (D16) — the single most important rule this ADR fixes, to be enforced by F27, not
F26:**

> **A successful Appointment write must not rely solely on a previous availability read.**

`GET .../availability` is **advisory only**, never a transactional guarantee. Two clients can observe the
same "free" interval concurrently (classic TOCTOU); a subsequent `POST` (F27) that skips its own
write-time revalidation could double-book. This project has already proven this exact class of problem
twice — Inventory's concurrent-stock-decrement test (F22) and Order's concurrent-confirm test (F23) both
forced two real simultaneous writes against the same resource and verified exactly one succeeded. F27 must
apply the same discipline to Appointment conflicts.

**Conceptual future mechanisms for F27 to evaluate (not selected, not built now):**
- A Postgres **exclusion constraint** on a `tstzrange` column scoped to `(organizationId, professionalId)`,
  using the `btree_gist` extension — this is exactly what F18's own `domain-model.md` SD-4 already proposed;
  F26A validates this proposal rather than inventing a fresh one, because it lets Postgres enforce
  "no two overlapping Appointments for the same Professional" natively, with a real constraint-violation
  error the application translates to `409 CONFLICT` — no application-level locking required, and it is
  provable with the exact same "force two real concurrent writes, assert exactly one wins" test pattern this
  project already uses twice.
- Alternative conceptual approaches (explicit row locking, Postgres advisory locks, an application-level
  transactional re-check of Scheduling before commit) remain open for F27 to evaluate against the exclusion-
  constraint approach — not decided here, since F27 has not yet gathered its own full requirements (the same
  restraint ADR-035 showed toward F26/F27 in F24A, and ADR-038 showed toward F26/F27 in F25A).

**Initial capacity invariant (D17):** one Professional = capacity 1 — no two overlapping Appointments for the
same Professional. This is the default the exclusion-constraint approach above naturally enforces. Group
classes/capacity > 1 are explicitly deferred, with a documented additive path (relaxing or replacing the
exclusion constraint, or introducing a capacity concept at the Appointment layer) — nothing in Scheduling's
own model (ADR-039) presumes or blocks this, since capacity is entirely an Appointment-layer concern.

**Initial multi-professional invariant (D18):** one Appointment → one Professional. Team/multi-professional
bookings are deferred, with a documented additive path (an `appointment_professionals` join table, mirroring
`professional_services`'s own N:M pattern) rather than a schema redesign.

**Initial multi-service invariant (D19):** one Appointment → one Service, restating F24A's own already-made
decision (ADR-035) and F18 SD-5 ("uma marcação = um serviço"). Multi-service appointments remain deferred
(OD-09), with the same additive-join-table extension path if ever needed.

---

**Self-booking boundary (D35).** F26 builds **staff-managed** scheduling only — an authenticated Organization
member with `scheduling.*` permission configuring a Professional's own hours. No public/customer-facing
booking or availability endpoint exists in F26 or is implied by this ADR. A later phase (F27+ or beyond)
would additionally need: a public availability read (likely unauthenticated or a lightweight guest session),
rate limiting (to prevent scraping/abuse of a public endpoint), an explicit booking policy (lead time,
cancellation window), and a real Customer-auth or guest-checkout flow — none of which is in scope now; this
section exists to draw the line clearly so F26 does not accidentally grow a public endpoint "while we're at
it."

## Alternatives

**Letting Scheduling store a `bookedBy`/`customerId` "just in case"** — rejected: the single clearest
violation of the WHEN vs. WHAT-HAS-BEEN-BOOKED boundary this ADR exists to prevent.

**Computing and returning "bookable" availability in F26, ahead of Appointment** — rejected (restated from
ADR-040/D14): bookable availability is only meaningful once conflicts can be subtracted; computing it early
would need to be redone the moment F27 exists, and risks the exact TOCTOU trap this ADR's concurrency
invariant warns against if a client mistakenly treats an early "bookable" response as a guarantee.

**Deciding F27's Appointment schema now "to save time later"** — rejected; not this phase's job (the same
restraint ADR-035/ADR-038 already showed toward phases that had not yet gathered their own requirements).
Only the boundary and the minimum future invariants (capacity, multi-professional, multi-service,
concurrency) are fixed here — enough to keep F26 from blocking F27, not a frozen Appointment table.

**Deciding the exact F27 conflict-enforcement mechanism now (exclusion constraint vs. locking vs.
application-level check)** — rejected; named as the leading candidate (matching F18's own SD-4) but left as
an explicit F27 evaluation, since committing to a specific mechanism without F27's own full requirements
would be exactly the kind of premature architecture this project's decision discipline (§14, simplicity
before scale) warns against.

## Consequences

- (+) F27 can be designed and built as a purely additive consumer of Scheduling — no redesign of
  `professional_schedule_rules`/`professional_schedule_exceptions`, `professionals`, `services`, or
  `professional_services` required (see F26A report §44 "F27 readiness" for the full proof).
- (+) The concurrency invariant is documented and testable-in-principle *before* any Appointment code exists,
  so F27 cannot "forget" to revalidate at write time — the expectation is on record now.
- (+) Scheduling stays small, testable, and shippable entirely on its own, exactly like Service (F24) and
  Professional (F25) were before their respective dependents existed.
- (−) F26 alone cannot answer "is this specific time slot actually bookable right now" — a real, deliberately
  deferred limitation (working availability only), not an oversight; documented prominently so no client
  code mistakes a `GET .../availability` response for a booking guarantee.

## Future extension path

F27 introduces `appointments` (+ a service/professional snapshot shape, mirroring `OrderItem`'s established
pattern) referencing `Organization`, `Customer`, `Professional`, `Service` — consulting Scheduling
(`professional_schedule_rules`/`professional_schedule_exceptions`) as a read-only input for availability, and
enforcing conflicts at write time via a mechanism it selects from the candidates above. Capacity > 1,
multi-professional, and multi-service each have a named, additive extension path if a real future
requirement demonstrates the need — none is built now, none is precluded by anything decided in F26A.
