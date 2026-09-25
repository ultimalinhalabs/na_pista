# ADR-048 — Appointment NO_SHOW Lifecycle

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F28A (spike) — implementation slice F28B

## Context

**Current state (F27):** states `SCHEDULED → COMPLETED | CANCELED`; `CHECK status IN (...)` lists exactly those three;
ADR-043 deferred NO_SHOW and told staff to cancel with a reason in the meantime. The conflict predicate is
`status <> 'CANCELED'`, chosen so that any future state occupies by default.

**Problem:** "the customer did not come" is operationally different from "the booking was called off": it matters for
future reporting (no-show rate per customer/professional) and policies, and recording it as CANCELED releases the
interval retroactively and mislabels history.

## Decision

- New terminal state **`NO_SHOW`**, reachable **only from `SCHEDULED`**, via a dedicated endpoint
  `POST …/appointments/:id/no-show` (no body). No other transition into or out of it.
- **When:** only once the server clock reaches `start_at` (the same time rule and source as `complete`; before that →
  `409 APPOINTMENT_NO_SHOW_TOO_EARLY`). **No upper window**: staff may record it later (late data entry is normal);
  restricting it would force mislabelling as CANCELED again.
- **Who:** `appointments.update` (OWNER/ADMIN/MANAGER), consistent with complete/cancel; STAFF read-only.
- **Terminal:** no undo, no transition to COMPLETED/CANCELED (same posture as COMPLETED; a mistaken mark is visible in
  audit, correction is deferred together with "completion undo").
- **Conflict:** NO_SHOW **keeps occupying** its interval — automatic under the existing predicate `status <> 'CANCELED'`
  (no constraint change). Rationale: the slot was reserved and its time has passed; releasing it retroactively has no
  operational use and would make history inconsistent with what was bookable at the time.
- **Row:** `no_show_at timestamptz NULL` + `CHECK ((status = 'NO_SHOW') = (no_show_at IS NOT NULL))`; `status_valid`
  CHECK extended with `'NO_SHOW'`. Lifecycle function gains the `no_show` action.
- **Audit:** `appointment.no_show` (transactional, like every transition). **Usage:** recorded after commit
  (`appointment.no_show:{id}`), like complete/cancel. **Event (ADR-050):** `appointment.no_show` — a valid Platform
  `domain.action` type.
- **Interim data:** appointments already canceled with a "no-show" reason are **not** backfilled — free-text reasons are
  not a reliable signal; reporting starts from F28B.

### Migration

Additive: add `no_show_at`, add its CHECK, replace `appointments_status_valid` with the 4-value list (drop + add in one
transaction; existing rows all satisfy it). The exclusion constraint is untouched. Rollback: only possible while no
NO_SHOW rows exist (documented; otherwise convert them to COMPLETED/CANCELED by explicit decision).

### Impacts

- **API:** new endpoint; `status` filter accepts `NO_SHOW`; representation adds `noShowAt`. Existing clients that
  switch on status must handle a fourth value — documented as the one client-visible contract extension.
- **UI:** "Não compareceu" action next to "Concluir" (same visibility rules); badge; list filter.
- **Tenant/authorization:** unchanged mechanisms. **Testing:** unit (transition matrix incl. NO_SHOW rows); integration
  (too-early, terminality, still blocks new bookings, audit + usage); concurrency (complete vs no-show on the same
  appointment → exactly one wins via the row lock); E2E (permission, entitlement, status filter).

## Alternatives

- **NO_SHOW releases the interval** — rejected (see Conflict).
- **A flag on CANCELED (`reason = NO_SHOW`)** — rejected: overloads a state with a second meaning; reporting must parse
  reasons.
- **Time window (e.g. only within 24h after start)** — rejected: no requirement; forces mislabelling.

## Consequences

- (+) Honest history; zero conflict-model change.
- (−) A fourth status value that clients must accept.
