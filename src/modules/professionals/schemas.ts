import { z } from "zod";
import { emailSchema, phoneSchema } from "../customers/schemas.js";

const uuidSchema = z.string().uuid();

/**
 * ADR-036: no `userId`/`customerId`/`serviceId`/`appointmentId`/
 * `scheduleId`/calendar/availability/working-hours/vacation/commission/
 * payroll/rating/booking fields — Professional is deliberately NOT a
 * Product/Service clone and NOT a Platform User. `phone`/`email` reuse
 * Customer's exact validators (imported, not duplicated) — informative
 * only, never authentication identity.
 */
export const createProfessionalSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    phone: phoneSchema,
    email: emailSchema,
  })
  .strict();

/**
 * `status` is accepted here (unlike on create, where a Professional
 * always starts ACTIVE) — ADR-036/F25A §19: lifecycle transitions use
 * `PATCH { status }`, not dedicated `/archive`/`/reactivate` endpoints
 * and never a `DELETE`, matching Service's just-established pattern.
 */
export const updateProfessionalSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    phone: phoneSchema.nullable(),
    email: emailSchema.nullable(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .strict();

/** Same shape as Products'/Customers'/Services' list query — status filter, name search (ILIKE), a hard safe limit, plus `serviceId` (ADR-037/F25A §14: filter to Professionals associated with a given Service). */
export const listProfessionalsQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    serviceId: uuidSchema.optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
