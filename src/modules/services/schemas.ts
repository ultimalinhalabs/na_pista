import { z } from "zod";
import { priceSchema } from "../products/schemas.js";

/**
 * ADR-034 (F24): `durationMinutes` is a plain JSON number, never a
 * decimal string — a deliberate exception to the money/quantity string
 * convention (a bounded positive integer has no float-precision problem
 * for that convention to solve). `.int()` rejects a decimal (45.5);
 * `.finite()` rejects NaN/Infinity; `.positive()` rejects zero/negative;
 * `z.number()` itself rejects a numeric STRING ("60") outright — no
 * `z.coerce.number()` here, unlike `limit` query-string parsing
 * elsewhere, because this is a JSON body field, not a query string (F24
 * brief §3: "rejeitar string numérica").
 */
const durationMinutesSchema = z
  .number("durationMinutes is required and must be a number")
  .finite("durationMinutes must be a finite number (no NaN/Infinity)")
  .int("durationMinutes must be an integer number of minutes, not a decimal")
  .positive("durationMinutes must be greater than 0");

/**
 * F24A/ADR-033: no `categoryId`/`unit`/`professionalId`/anything
 * scheduling-shaped — Service is deliberately NOT a Product clone.
 * `price` reuses Product's exact validator (ADR-034) — same duality
 * (number or decimal string), same NULL-vs-0 semantics.
 */
export const createServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    durationMinutes: durationMinutesSchema,
    price: priceSchema.optional(),
  })
  .strict();

/**
 * `status` is accepted here (unlike on create, where a Service always
 * starts ACTIVE) — F24A/ADR-033 §19: lifecycle transitions use
 * `PATCH { status }`, not dedicated `/archive`/`/reactivate` endpoints
 * and never a `DELETE`. `price: null` explicitly clears it back to
 * "not yet priced" (distinct from `0`, ADR-034).
 */
export const updateServiceSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    durationMinutes: durationMinutesSchema.optional(),
    price: priceSchema.nullable().optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .strict();

/** Same shape as Products'/Customers' list query — status filter, name search (ILIKE), a hard safe limit. */
export const listServicesQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
