import { computeAvailability, type ScheduleExceptionRow, type ScheduleRuleRow } from "../scheduling/availability.js";
import { addMinutes, localToInstant, toLocal } from "./time.js";

/**
 * F27 (ADR-044 "Write-time validation against F26"): the pure bridge
 * between F26's wall-clock availability engine and absolute Appointment
 * instants. It REUSES `computeAvailability` unchanged — it never
 * re-implements working-interval resolution, exception precedence, the
 * 15-minute grid, or duration fitting. Availability computed here is
 * ADVISORY; the database exclusion constraint is the only authority on
 * conflicts.
 */

export interface ScheduleInput {
  rules: ScheduleRuleRow[];
  exceptions: ScheduleExceptionRow[];
}

/** F26's `serviceStartTimes` for ONE local date and ONE duration — "HH:mm" wall-clock strings. */
export function serviceStartTimesForDate(schedule: ScheduleInput, date: string, durationMinutes: number): string[] {
  const [day] = computeAvailability({ rules: schedule.rules, exceptions: schedule.exceptions, from: date, to: date, durationMinutes });
  return day?.serviceStartTimes ?? [];
}

/**
 * Is `startAt` (absolute) a valid F26 service start for `durationMinutes`
 * in the organization's local calendar? One membership check encodes:
 * working day, exception-replaces-day precedence, the grid anchored at
 * each interval's start, and "the whole duration fits inside one working
 * interval" (F27A §3/§17 — strict, no override).
 */
export function isWithinAvailability(schedule: ScheduleInput, startAt: Date, durationMinutes: number, timeZone: string): boolean {
  const local = toLocal(startAt, timeZone);
  return serviceStartTimesForDate(schedule, local.date, durationMinutes).includes(local.time);
}

export interface Interval {
  startAt: Date;
  endAt: Date;
}

export interface BookableSlot {
  localStartTime: string;
  startAt: Date;
  endAt: Date;
}

/** Half-open `[start, end)` overlap — the exact semantics of the DB constraint's `tstzrange(..., '[)') &&`. */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();
}

/**
 * ADR-040 "bookable = working − appointment conflicts": F26 start times
 * for the date, converted to absolute instants (a start falling in a DST
 * gap is skipped; an ambiguous one resolves to its first occurrence),
 * minus every slot overlapping an OCCUPYING appointment (callers pass
 * non-canceled appointments only), minus slots outside the booking window
 * (`[now, now + horizon]`) — because creation would reject them anyway.
 * Never persisted.
 */
export function computeBookableSlots(params: {
  schedule: ScheduleInput;
  date: string;
  durationMinutes: number;
  timeZone: string;
  occupied: Interval[];
  now: Date;
  horizonEnd: Date;
}): BookableSlot[] {
  const slots: BookableSlot[] = [];
  for (const localStartTime of serviceStartTimesForDate(params.schedule, params.date, params.durationMinutes)) {
    const startAt = localToInstant(params.date, localStartTime, params.timeZone);
    if (!startAt) continue;
    if (startAt.getTime() < params.now.getTime() || startAt.getTime() > params.horizonEnd.getTime()) continue;
    const slot = { localStartTime, startAt, endAt: addMinutes(startAt, params.durationMinutes) };
    if (params.occupied.some((busy) => intervalsOverlap(slot, busy))) continue;
    slots.push(slot);
  }
  return slots;
}
