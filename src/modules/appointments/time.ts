/**
 * F27 (ADR-040/044): the ONE place Na Pista converts between absolute
 * instants (`timestamptz`, JS `Date`) and an organization's local wall
 * clock. Pure, no I/O, no dependency — Node's built-in `Intl` timezone
 * database only (the same database F26 already validates IANA identifiers
 * against). The timezone is ALWAYS passed in explicitly from
 * `organization_settings` — this module never reads the server timezone
 * (`process.env.TZ`), a browser timezone, or any default.
 *
 * F26's availability engine stays purely wall-clock (it never receives a
 * timezone); these helpers are the boundary where F27 turns its local
 * answers into absolute Appointment instants and back.
 */

export interface LocalDateTime {
  /** "YYYY-MM-DD" in the organization's calendar. */
  date: string;
  /** "HH:mm" wall-clock. */
  time: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws `RangeError` for an unknown IANA identifier — never silently falls back. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The local wall-clock reading of `instantMs` in `timeZone`, re-expressed as if it were a UTC epoch (a "wall epoch") — makes offset arithmetic plain subtraction. */
function wallEpoch(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}

/** UTC offset (ms, local minus UTC) in effect at `instantMs`. */
function offsetAt(instantMs: number, timeZone: string): number {
  return wallEpoch(instantMs, timeZone) - Math.floor(instantMs / 1000) * 1000;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Absolute instant -> organization-local date/time. Always unambiguous (UTC -> local is a function). */
export function toLocal(instant: Date, timeZone: string): LocalDateTime {
  const wall = new Date(wallEpoch(instant.getTime(), timeZone));
  return {
    date: `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
    time: `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`,
  };
}

function parseWall(date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return Date.UTC(year!, month! - 1, day!, hours!, minutes!);
}

/**
 * Organization-local date/time -> absolute instant, implementing ADR-040's
 * DST contract:
 *  - an AMBIGUOUS local time (fall-back overlap, occurs twice) resolves to
 *    its FIRST occurrence — the earlier instant;
 *  - a NONEXISTENT local time (spring-forward gap) returns `null` with
 *    `gap: "skip"` (the default — a bookable slot at that time is simply
 *    skipped), or, with `gap: "forward"`, the instant the clock jumps to
 *    (used only for day-window boundaries, where "skip" has no meaning).
 */
export function localToInstant(date: string, time: string, timeZone: string, options: { gap?: "skip" | "forward" } = {}): Date | null {
  const wall = parseWall(date, time);
  const candidates = new Set([offsetAt(wall - DAY_MS, timeZone), offsetAt(wall, timeZone), offsetAt(wall + DAY_MS, timeZone)]);
  const valid = [...candidates]
    .map((offset) => wall - offset)
    .filter((instant) => wallEpoch(instant, timeZone) === wall)
    .sort((a, b) => a - b);
  if (valid.length > 0) return new Date(valid[0]!);
  if (options.gap === "forward") {
    // In a gap the offset increases; interpreting the wall time with the
    // PRE-gap offset lands exactly on the post-gap wall clock.
    return new Date(wall - offsetAt(wall - DAY_MS, timeZone));
  }
  return null;
}

/** "YYYY-MM-DD" + n calendar days (pure calendar arithmetic, timezone-free). */
export function addDays(date: string, days: number): string {
  return new Date(parseWall(date, "00:00") + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of calendar dates between two "YYYY-MM-DD" strings (`from == to` -> 1). */
export function inclusiveDayCount(from: string, to: string): number {
  return Math.round((parseWall(to, "00:00") - parseWall(from, "00:00")) / DAY_MS) + 1;
}

/**
 * The absolute half-open window `[local midnight of from, local midnight of
 * to + 1 day)` covering the inclusive local date range — how list/slot
 * queries phrased in organization-local dates become `timestamptz` bounds.
 * A midnight that falls in a DST gap moves forward to the first existing
 * instant (never skipped — a window boundary must always exist).
 */
export function localDateWindow(from: string, to: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: localToInstant(from, "00:00", timeZone, { gap: "forward" })!,
    end: localToInstant(addDays(to, 1), "00:00", timeZone, { gap: "forward" })!,
  };
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

/** Whole minutes between two instants — an Appointment's frozen duration is `end_at - start_at`. */
export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MINUTE_MS);
}
