import { z } from "zod";
import { localDateSchema } from "../scheduling/schemas.js";
import { APPOINTMENT_STATUSES } from "./lifecycle.js";
import { inclusiveDayCount } from "./time.js";

const uuidSchema = z.string("must be a string").uuid("must be a valid UUID");

/** Same "YYYY-MM-DD" shape F26 uses, additionally rejecting impossible calendar dates (e.g. 2026-02-31). */
const realLocalDateSchema = localDateSchema.refine((date) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}, "must be a real calendar date");

/**
 * ADR-040/042: an absolute instant, ISO-8601 WITH an explicit `Z` or
 * offset (`2026-10-05T09:00:00Z`, `2026-10-05T10:00:00+01:00`) — never a
 * bare local string, which would be ambiguous. Whole minutes only
 * (seconds and milliseconds must be zero): every valid start sits on
 * F26's minute grid anyway, and this rejects accidental "now()"-style
 * timestamps early. Transformed to a `Date`.
 */
const instantSchema = z
  .string("must be a string")
  .datetime({ offset: true, message: "must be an ISO-8601 timestamp with Z or an explicit offset" })
  .transform((value) => new Date(value))
  .refine((date) => date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0, "must be a whole minute (seconds and milliseconds must be 0)");

/** ADR-042: one internal staff note, ≤ 2000 chars; whitespace-only is stored as NULL (no note), never as an empty string. */
const notesSchema = z
  .string("must be a string")
  .max(2000, "notes cannot exceed 2000 characters")
  .transform((value) => (value.trim() === "" ? null : value.trim()));

/**
 * F27A §40: the client supplies WHO/WHAT/WHEN only. `endAt`/duration,
 * `status`, snapshots (`serviceName`/`servicePrice`/`currency`) and
 * `organizationId` are always server-derived — `.strict()` rejects any
 * attempt to send them.
 */
export const createAppointmentSchema = z
  .object({
    customerId: uuidSchema,
    professionalId: uuidSchema,
    serviceId: uuidSchema,
    startAt: instantSchema,
    notes: notesSchema.optional(),
  })
  .strict();

/**
 * ADR-043: `startAt`/`professionalId` = reschedule; `notes` (nullable to
 * clear) = edit. `customerId`, `serviceId`, `status`, `endAt` are NOT
 * accepted — `.strict()` rejects them, so no PATCH can change who is
 * served, what was booked, the frozen duration, or bypass the dedicated
 * cancel/complete transitions.
 */
export const updateAppointmentSchema = z
  .object({
    startAt: instantSchema.optional(),
    professionalId: uuidSchema.optional(),
    notes: notesSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => body.startAt !== undefined || body.professionalId !== undefined || body.notes !== undefined, {
    message: "at least one of startAt, professionalId, notes is required",
  });

export const cancelAppointmentSchema = z
  .object({
    reason: z.string("must be a string").trim().min(1, "reason cannot be empty").max(500, "reason cannot exceed 500 characters").optional(),
  })
  .strict();

/** F27A §41: listing is ALWAYS bounded — both dates required, at most 31 local days inclusive. */
export const MAX_APPOINTMENT_LIST_DAYS = 31;

export const listAppointmentsQuerySchema = z
  .object({
    from: realLocalDateSchema,
    to: realLocalDateSchema,
    professionalId: uuidSchema.optional(),
    customerId: uuidSchema.optional(),
    serviceId: uuidSchema.optional(),
    status: z.enum(APPOINTMENT_STATUSES).optional(),
    limit: z.coerce.number().int().positive().max(500).default(200),
  })
  .strict()
  .refine((query) => query.to >= query.from, { message: "to must be on or after from", path: ["to"] })
  .refine((query) => inclusiveDayCount(query.from, query.to) <= MAX_APPOINTMENT_LIST_DAYS, {
    message: `the requested range cannot exceed ${MAX_APPOINTMENT_LIST_DAYS} days`,
    path: ["to"],
  });

/** F27A §40: one local date, one Service — both required. */
export const bookableSlotsQuerySchema = z
  .object({
    date: realLocalDateSchema,
    serviceId: uuidSchema,
  })
  .strict();
