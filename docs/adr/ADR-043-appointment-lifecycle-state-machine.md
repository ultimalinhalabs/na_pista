# ADR-043 — Appointment Lifecycle & State Machine

- **Estado:** Accepted — implemented (F27)
- **Data:** 2026-09-25
- **Phase:** F27A (spike)

## Context

F18 SD-5 left the Appointment states open ("minimal proposal `SCHEDULED → COMPLETED | CANCELED`; `CONFIRMED`
and `NO_SHOW` depend on the business"). F27's initial consumer is **staff-managed booking** in Na Pista
Console (an authenticated member books on a customer's behalf, typically by phone/WhatsApp/at the counter).
The lifecycle must support that operationally, keep a meaningful history, and interact correctly with the
conflict invariant (ADR-044) — without inventing approval workflows no one asked for.

## Decision

### States — three

| State | Meaning | Occupies the Professional's time? | Reschedulable | Cancelable | Terminal |
|---|---|---|---|---|---|
| `SCHEDULED` | Booked and committed. Created directly in this state. | **Yes** | Yes | Yes | No |
| `COMPLETED` | The service took place. | **Yes** (historical fact — the time was used) | No | No | **Yes** |
| `CANCELED` | Will not / did not happen. Kept for history. | **No** — releases the interval | No | No | **Yes** |

**Creation = `SCHEDULED` = booked.** `POST` means "this booking is committed now", validated against
availability and the conflict constraint. There is no `DRAFT` (nothing to assemble step-by-step, unlike an
Order's item list; a draft that does not hold time is useless, one that does is just `SCHEDULED`) and no
`REQUESTED`/approval step (staff *are* the approvers).

**No `CONFIRMED`.** For staff-created bookings, "confirmed" carries no distinct operational meaning — the staff
member confirmed it by creating it. A customer-confirmation step only becomes meaningful with notifications
(send reminder → customer confirms) or self-booking with approval, both deferred. Additive path: a nullable
`confirmed_at` column (preferred — confirmation is an attribute of a SCHEDULED booking, not a separate
occupancy state) or a new state; neither affects the conflict constraint (ADR-044 predicate is
`status <> 'CANCELED'`, so any new non-canceled state blocks time by default — fail-safe).

**`NO_SHOW` — deferred.** It is a real operational fact, but no F27 consumer (report, penalty, cancellation
policy, customer history metric) reads it. Interim: staff cancel with `reason` (e.g. "Cliente não compareceu").
Additive path: new terminal state `NO_SHOW`, reachable only from `SCHEDULED` after `start_at`, occupying time
(automatic under the `<> 'CANCELED'` predicate); plus a data backfill decision for interim canceled rows —
explicitly accepted as a small future cost.

### Transition matrix

| Current | Action | Next | Preconditions | Permission |
|---|---|---|---|---|
| — | `create` | `SCHEDULED` | Customer/Professional/Service ACTIVE, associated; timezone configured; start in the future (≤ 365 days); start ∈ F26 `serviceStartTimes`; no conflict | `appointments.create` |
| `SCHEDULED` | `reschedule` (PATCH `startAt` and/or `professionalId`) | `SCHEDULED` | same validations as create, for the new time/professional; duration preserved | `appointments.update` |
| `SCHEDULED` | `update notes` (PATCH `notes`) | `SCHEDULED` | none beyond state | `appointments.update` |
| `SCHEDULED` | `cancel` | `CANCELED` | none (any time, before or after start) | `appointments.update` |
| `SCHEDULED` | `complete` | `COMPLETED` | `now >= start_at` | `appointments.update` |

**Forbidden (→ `409 INVALID_APPOINTMENT_STATE`):** any action on `CANCELED` or `COMPLETED`
(`CANCELED → SCHEDULED`, `CANCELED → COMPLETED`, `COMPLETED → CANCELED`, `COMPLETED → SCHEDULED`, editing or
rescheduling either); `complete` before `start_at`; `cancel`/`complete` repeated. No resurrection: a canceled
booking that should happen after all is a **new** Appointment (which re-runs availability and the conflict
constraint — un-canceling in place could silently double-book, proven by probe row I in the F27A report §32).
A wrongly-completed appointment has no administrative undo in F27 (deferred; the audit trail records who did
it) — acceptable because completion has no side effects yet (no payment, no stock, no notification).

### Per-action semantics

- **Reschedule** is an in-place `UPDATE` of the same row (no Reschedule entity): `start_at`, `end_at`
  (`= new start + existing duration`), optionally `professional_id`. Snapshots (`service_name`,
  `service_price`, `currency`) are **not** re-captured. `customer_id` and `service_id` are **immutable** —
  changing who is served or what is booked is a different booking (cancel + create); this also keeps the
  price snapshot honest. The update is subject to the identical conflict guarantee as insert (ADR-044).
- **Cancel**: sets `status='CANCELED'`, `canceled_at=now()`, optional `cancellation_reason` (≤ 500 chars).
  Releases the interval immediately (the row leaves the constraint predicate). No cancellation window/policy,
  no fees, no notification in F27. Actor is recorded in audit (not duplicated on the row).
- **Complete**: sets `status='COMPLETED'`, `completed_at=now()`. Allowed from `start_at` onward (a session can
  end early; completing a future booking is a data-entry error). Keeps occupying the interval. No billing.
- **Past SCHEDULED appointments** stay `SCHEDULED` until staff act. No background auto-completion job in F27.
- All transitions lock the row (`SELECT … FOR UPDATE`, the `orders` precedent) so a concurrent cancel and
  reschedule/complete on the same appointment serialize; the loser sees the real state and gets `409`.

### DB-level backing

`CHECK (status IN ('SCHEDULED','COMPLETED','CANCELED'))`;
`CHECK ((status = 'CANCELED') = (canceled_at IS NOT NULL))`;
`CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL))`;
`CHECK (cancellation_reason IS NULL OR status = 'CANCELED')`.
Transition *legality* (from→to) lives in a pure domain function (unit-tested); the CHECKs guarantee the row is
never internally inconsistent whatever code path writes it.

### Self-booking boundary

The same states and transitions serve future customer self-booking unchanged: a self-booked appointment is
created `SCHEDULED` by the same domain service (same availability validation, same constraint). What
self-booking adds is *outside* this state machine: customer authentication or guest identity resolution to a
Na Pista Customer, a public bookable-slots read, rate limiting, `Idempotency-Key`, lead-time and
cancellation-window policy, and possibly `confirmed_at`. None is built in F27.

## Alternatives

- **`DRAFT → SCHEDULED`** — rejected: no multi-step assembly, and a non-occupying draft invites TOCTOU.
- **`SCHEDULED → CONFIRMED → COMPLETED`** — rejected for F27: approval workflow without an approver/notifier.
- **Include `NO_SHOW` now** — rejected: no consumer; additive later at low cost.
- **Allow un-cancel** — rejected: resurrection bypasses booking-time validation; rebook instead.
- **`DELETE` on cancel** — rejected: F18 SD-5 / invariant 5 — business history is never deleted.
- **Separate `appointments.cancel`/`appointments.complete` permissions** — rejected (report §36), mirrors
  `orders.update` covering Order transitions (F23).

## Consequences

- (+) Three states, two terminal, one active — trivially testable, maps 1:1 to the conflict predicate.
- (+) Any future state is safe by default with respect to double-booking.
- (−) No-shows are recorded as cancellations-with-reason until `NO_SHOW` is added.
- (−) No undo for completion/cancellation in F27.

## Implementation note (F27)

Implemented as decided. One error-code refinement, no semantic change: "complete before `start_at`" is
reported as `409 APPOINTMENT_COMPLETION_TOO_EARLY` (the F27 brief's code) rather than the generic
`409 INVALID_APPOINTMENT_STATE` named above — same status, same rule, a more specific code for clients.
`INVALID_APPOINTMENT_STATE` keeps meaning "any action on a terminal appointment". See `docs/f27-report.md` §2.
