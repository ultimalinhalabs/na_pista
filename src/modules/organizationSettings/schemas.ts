import { z } from "zod";

/**
 * ADR-040: IANA identifier only, validated against the runtime's own
 * timezone database (`Intl.supportedValuesOf("timeZone")`) — no
 * external dependency, no raw UTC offset accepted, no hand-maintained
 * list. Computed once at module load (the runtime's timezone database
 * does not change during a process's lifetime).
 */
const IANA_TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

export const timezoneSchema = z
  .string("timezone is required and must be a string")
  .trim()
  .min(1)
  .refine((value) => IANA_TIMEZONES.has(value), { message: 'must be a valid IANA timezone identifier, e.g. "Africa/Luanda"' });

export const updateOrganizationSettingsSchema = z
  .object({
    timezone: timezoneSchema,
  })
  .strict();
