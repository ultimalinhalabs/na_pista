import { z } from "zod";

/**
 * ADR-039: wall-clock local time, "HH:mm" (24h), no timezone suffix —
 * attaching one here would misleadingly imply an absolute instant
 * (ADR-040 §"API payload representation"). Deliberately NOT
 * `z.string().time()` (Zod's ISO time validator accepts seconds/
 * fractional-seconds/offsets we don't want) — a plain regex keeps the
 * accepted shape exact.
 */
export const localTimeSchema = z
  .string("must be a string")
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be "HH:mm" (24h), e.g. "08:00"');

/** Plain calendar date, "YYYY-MM-DD" — the organization's own calendar date, never a UTC-anchored timestamp (ADR-040). */
export const localDateSchema = z.string("must be a string").regex(/^\d{4}-\d{2}-\d{2}$/, 'must be "YYYY-MM-DD"');

const dayOfWeekSchema = z
  .number("dayOfWeek is required and must be a number")
  .finite("dayOfWeek must be a finite number")
  .int("dayOfWeek must be an integer (0=Sunday .. 6=Saturday)")
  .min(0, "dayOfWeek must be between 0 and 6")
  .max(6, "dayOfWeek must be between 0 and 6");

/**
 * ADR-039: one row per interval — `startLocalTime < endLocalTime`
 * required (the DB `CHECK` restates this; validated here too so a
 * malformed request never reaches the database). **Overnight intervals
 * are explicitly NOT supported in F26** (ADR-039 D3) — this schema
 * cannot express `endLocalTime < startLocalTime` as "wrap to next day";
 * it is simply rejected.
 */
const scheduleRuleSchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    startLocalTime: localTimeSchema,
    endLocalTime: localTimeSchema,
  })
  .strict()
  .refine((rule) => rule.endLocalTime > rule.startLocalTime, {
    message: "endLocalTime must be after startLocalTime (overnight intervals are not supported)",
    path: ["endLocalTime"],
  });

/**
 * ADR-039 D10: the whole weekly set is replaced atomically on every
 * `PUT` — never a partial patch. An empty array is valid and means
 * "closed every day" (ADR-039 D33: empty = unavailable). Cross-row
 * overlap validation (same-day intervals must not overlap; adjacent
 * intervals like `08:00-12:00`/`12:00-17:00` ARE accepted, not merged —
 * docs/f26-report.md §8) happens in the domain service, not here — it
 * needs to compare rows against each other, not a single row in
 * isolation.
 */
export const replaceScheduleSchema = z
  .object({
    rules: z.array(scheduleRuleSchema).max(100, "too many rules in one request"),
  })
  .strict();

/**
 * ADR-039 D4: `startLocalTime`/`endLocalTime` both present = an
 * available-interval row; both absent = the "fully unavailable this
 * date" closed-marker row. Providing exactly one of the two is rejected
 * — an ambiguous half-shape the domain model has no meaning for.
 */
export const createExceptionSchema = z
  .object({
    date: localDateSchema,
    startLocalTime: localTimeSchema.optional(),
    endLocalTime: localTimeSchema.optional(),
  })
  .strict()
  .refine((body) => (body.startLocalTime === undefined) === (body.endLocalTime === undefined), {
    message: "startLocalTime and endLocalTime must both be present (an interval) or both be absent (fully unavailable)",
    path: ["endLocalTime"],
  })
  .refine((body) => body.startLocalTime === undefined || body.endLocalTime === undefined || body.endLocalTime > body.startLocalTime, {
    message: "endLocalTime must be after startLocalTime (overnight intervals are not supported)",
    path: ["endLocalTime"],
  });

/**
 * ADR-039/040 D34: a bounded query horizon — an architectural
 * expectation ("a few months, not years"), implemented here as a fixed
 * 92-day (~3 month) maximum. Not per-organization-configurable; no
 * demonstrated need for that yet (same deferred-tuning posture as the
 * booking-increment constant in availability.ts).
 */
export const MAX_AVAILABILITY_RANGE_DAYS = 92;

export const availabilityQuerySchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
    serviceId: z.string("serviceId must be a string").uuid("serviceId must be a valid UUID").optional(),
  })
  .strict()
  .refine((query) => query.to >= query.from, { message: "to must be on or after from", path: ["to"] })
  .refine(
    (query) => {
      const from = new Date(`${query.from}T00:00:00Z`);
      const to = new Date(`${query.to}T00:00:00Z`);
      const days = (to.getTime() - from.getTime()) / 86_400_000;
      return days <= MAX_AVAILABILITY_RANGE_DAYS;
    },
    { message: `the requested range cannot exceed ${MAX_AVAILABILITY_RANGE_DAYS} days`, path: ["to"] },
  );
