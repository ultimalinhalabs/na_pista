import {
  AppointmentCompletionTooEarlyError,
  AppointmentNoShowTooEarlyError,
  BookingHorizonExceededError,
  InvalidAppointmentStateError,
  ValidationError,
} from "../../shared/errors.js";

/**
 * F27 (ADR-043): the whole Appointment state machine, as pure functions —
 * no DB, no clock of its own (`now` is always passed in by the domain
 * service from the SERVER clock; never client-supplied).
 *
 *   (create) -> SCHEDULED
 *   SCHEDULED -> reschedule / edit notes -> SCHEDULED
 *   SCHEDULED -> cancel   -> CANCELED   (terminal, releases its interval)
 *   SCHEDULED -> complete -> COMPLETED  (terminal, only once now >= start_at)
 *   SCHEDULED -> no_show  -> NO_SHOW    (terminal, only once now >= start_at, no deadline — F28B, ADR-048)
 *
 * No DRAFT or CONFIRMED (deferred, ADR-043). Every action on a
 * terminal appointment is rejected — no resurrection: rebooking the same
 * time is a NEW Appointment that re-runs availability and the conflict
 * constraint.
 */
export const APPOINTMENT_STATUSES = ["SCHEDULED", "COMPLETED", "CANCELED", "NO_SHOW"] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export type AppointmentAction = "reschedule" | "update" | "cancel" | "complete" | "no_show";

/** Mirrors the DB constraint predicate `status <> 'CANCELED'` (ADR-044): every non-canceled state occupies the Professional's time — including NO_SHOW (ADR-048: the reserved time has passed; it is never released retroactively). */
export function occupiesTime(status: AppointmentStatus): boolean {
  return status !== "CANCELED";
}

export function isTerminal(status: AppointmentStatus): boolean {
  return status === "COMPLETED" || status === "CANCELED" || status === "NO_SHOW";
}

const NEXT_STATE: Record<AppointmentAction, AppointmentStatus> = {
  reschedule: "SCHEDULED",
  update: "SCHEDULED",
  cancel: "CANCELED",
  complete: "COMPLETED",
  no_show: "NO_SHOW",
};

/**
 * Validates one action against the current status and returns the
 * resulting status. `complete` and `no_show` additionally require
 * `now >= startAt` (a session may finish early, so `end_at` is NOT required
 * to have passed; a no-show has no upper deadline — ADR-048).
 */
export function assertTransition(current: AppointmentStatus, action: AppointmentAction, context: { now?: Date; startAt?: Date } = {}): AppointmentStatus {
  if (current !== "SCHEDULED") {
    throw new InvalidAppointmentStateError(`Cannot ${action} an appointment in status ${current}`);
  }
  if (action === "complete" || action === "no_show") {
    if (!context.now || !context.startAt) throw new Error(`BUG: ${action} transition requires now and startAt`);
    if (context.now.getTime() < context.startAt.getTime()) {
      throw action === "complete" ? new AppointmentCompletionTooEarlyError() : new AppointmentNoShowTooEarlyError();
    }
  }
  return NEXT_STATE[action];
}

/** F27 frozen decision: booking horizon 365 days, absolute and inclusive (`startAt <= now + 365 * 24h`). */
export const BOOKING_HORIZON_DAYS = 365;

/**
 * Creation and rescheduling only (ADR-043). Evaluated on absolute instants
 * — the canonical time semantics — so no timezone or offset spelling in the
 * request can move a start across either bound. The lower bound is `now`
 * itself: an appointment cannot be booked or moved into the past.
 */
export function assertWithinBookingWindow(startAt: Date, now: Date): void {
  if (startAt.getTime() < now.getTime()) {
    throw new ValidationError("startAt must not be in the past");
  }
  if (startAt.getTime() > now.getTime() + BOOKING_HORIZON_DAYS * 86_400_000) {
    throw new BookingHorizonExceededError();
  }
}
