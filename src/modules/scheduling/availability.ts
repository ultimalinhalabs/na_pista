/**
 * Pure availability computation (ADR-039/ADR-040) — no DB access, no
 * I/O, deliberately isolated so its overlap/precedence/start-time logic
 * is unit-testable without a database (docs/f26a-report.md §42).
 *
 * Everything here operates on local wall-clock values ("HH:mm" strings,
 * "YYYY-MM-DD" date strings) — ADR-040's whole point is that recurring
 * schedule math never needs to cross into absolute-instant/UTC territory
 * at all, so this module intentionally takes no `timezone` parameter:
 * the Organization's configured timezone only gates WHETHER Scheduling
 * is usable at all (checked once, in `service.ts`, fail-closed) and is
 * echoed back in the API response for client clarity — it plays no part
 * in this module's own interval arithmetic. Real timezone/DST
 * conversion only becomes necessary once F27 introduces absolute
 * `timestamptz` Appointment instants — genuinely out of scope for any
 * code path F26 actually exercises (see docs/f26-report.md §11 for why
 * this means F26 has no DST-sensitive code to test, only a documented
 * future contract).
 */

export interface Interval {
  start: string; // "HH:mm"
  end: string; // "HH:mm"
}

export interface ScheduleRuleRow {
  dayOfWeek: number;
  startLocalTime: string;
  endLocalTime: string;
}

export interface ScheduleExceptionRow {
  date: string;
  startLocalTime: string | null;
  endLocalTime: string | null;
}

export interface DayAvailability {
  date: string;
  workingIntervals: Interval[];
  /** Present only when a service duration was supplied — valid start times, NOT a booking guarantee (ADR-041: no Appointment conflicts exist to subtract in F26). */
  serviceStartTimes?: string[];
}

/** Two intervals overlap iff `a.start < b.end && b.start < a.end` — touching/adjacent endpoints (`08:00-12:00`/`12:00-17:00`) do NOT count as overlap (docs/f26-report.md §8: adjacent intervals are accepted, not merged, not rejected). */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The first overlapping pair found among same-day intervals, order-independent — used to validate both a weekly rule's per-day set and an exception date's interval set. */
export function findOverlappingPair(intervals: Interval[]): [Interval, Interval] | null {
  for (let i = 0; i < intervals.length; i++) {
    for (let j = i + 1; j < intervals.length; j++) {
      if (intervalsOverlap(intervals[i]!, intervals[j]!)) return [intervals[i]!, intervals[j]!];
    }
  }
  return null;
}

function sortIntervals(intervals: Interval[]): Interval[] {
  return [...intervals].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** "YYYY-MM-DD" parsed at UTC midnight so the result never depends on the server's own local timezone — a calendar date's day-of-week is a property of the date itself, not of any timezone (ADR-040). 0=Sunday..6=Saturday, matching `professional_schedule_rules.dayOfWeek`. */
export function dayOfWeekForDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function enumerateDates(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  while (cursor <= end) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return dates;
}

/**
 * Per-date working intervals (ADR-039 D1/D14): for a date with any
 * exception rows, those rows COMPLETELY REPLACE the weekly rule for
 * that date (a closed-marker row, or zero exception rows for that date
 * once filtered, both yield an empty interval list) — never a merge
 * with the weekly rule. Otherwise, the weekly rule for that date's
 * `dayOfWeek` applies as-is. Zero rules/exceptions for a date = empty
 * intervals = unavailable (ADR-039 D33, fail-closed default).
 */
export function computeWorkingIntervals(params: {
  rules: ScheduleRuleRow[];
  exceptions: ScheduleExceptionRow[];
  from: string;
  to: string;
}): { date: string; intervals: Interval[] }[] {
  const exceptionsByDate = new Map<string, ScheduleExceptionRow[]>();
  for (const exception of params.exceptions) {
    const list = exceptionsByDate.get(exception.date) ?? [];
    list.push(exception);
    exceptionsByDate.set(exception.date, list);
  }

  return enumerateDates(params.from, params.to).map((date) => {
    const dayExceptions = exceptionsByDate.get(date);
    if (dayExceptions && dayExceptions.length > 0) {
      const intervals = dayExceptions
        .filter((row): row is ScheduleExceptionRow & { startLocalTime: string; endLocalTime: string } => row.startLocalTime !== null && row.endLocalTime !== null)
        .map((row) => ({ start: row.startLocalTime, end: row.endLocalTime }));
      return { date, intervals: sortIntervals(intervals) };
    }
    const dayOfWeek = dayOfWeekForDate(date);
    const intervals = params.rules.filter((rule) => rule.dayOfWeek === dayOfWeek).map((rule) => ({ start: rule.startLocalTime, end: rule.endLocalTime }));
    return { date, intervals: sortIntervals(intervals) };
  });
}

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours! * 60 + minutes!;
}

function minutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60).toString().padStart(2, "0");
  const minutes = (totalMinutes % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * ADR-040 D10: a fixed, non-configurable booking increment — no proven
 * requirement yet for per-organization configurability (docs/f26-
 * report.md §13).
 */
export const BOOKING_INCREMENT_MINUTES = 15;

/** Valid service start times within ONE working interval — the entire service duration must fit before the interval ends. An interval shorter than `durationMinutes` yields zero start times (never a partial/truncated booking). Advisory only — no Appointment conflicts exist to subtract in F26 (ADR-041). */
export function computeStartTimes(interval: Interval, durationMinutes: number): string[] {
  const startTimes: string[] = [];
  const intervalStart = timeToMinutes(interval.start);
  const intervalEnd = timeToMinutes(interval.end);
  for (let start = intervalStart; start + durationMinutes <= intervalEnd; start += BOOKING_INCREMENT_MINUTES) {
    startTimes.push(minutesToTime(start));
  }
  return startTimes;
}

/**
 * The full F26 availability engine (ADR-039/040/041 §"Availability
 * computation"): working intervals always returned; `serviceStartTimes`
 * additionally computed, per date, when `durationMinutes` is supplied —
 * this is the point where "working availability" (always returned) and
 * "service-aware availability" (only with a duration) are explicitly
 * distinguished, never conflated (docs/f26a-report.md §18).
 */
export function computeAvailability(params: {
  rules: ScheduleRuleRow[];
  exceptions: ScheduleExceptionRow[];
  from: string;
  to: string;
  durationMinutes?: number;
}): DayAvailability[] {
  const perDay = computeWorkingIntervals(params);
  if (params.durationMinutes === undefined) {
    return perDay.map(({ date, intervals }) => ({ date, workingIntervals: intervals }));
  }
  const durationMinutes = params.durationMinutes;
  return perDay.map(({ date, intervals }) => ({
    date,
    workingIntervals: intervals,
    serviceStartTimes: intervals.flatMap((interval) => computeStartTimes(interval, durationMinutes)),
  }));
}
