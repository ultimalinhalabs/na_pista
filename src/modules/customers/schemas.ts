import { z } from "zod";

/**
 * Phone: loose, international-friendly (F21 brief §8 — must work naturally
 * with Angolan numbers like `+244...` but never become Angola-only, and
 * must not pull in an arbitrary global phone-number library the project
 * has no existing convention for). Accepts an optional leading `+` and
 * 7-20 digits/spaces/dashes/parentheses — a shape check, not a real
 * validity check (no country-code table, no length-per-country rules).
 *
 * Exported (F25, ADR-036): `Professional.phone`/`Professional.email`
 * reuse these exact validators — never duplicated, never authentication
 * identity for either entity.
 */
export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9()\-\s]{7,20}$/, "Invalid phone number format")
  .optional();

const nameSchema = z.string().trim().min(1).max(200);
export const emailSchema = z.string().trim().email().max(320).optional();
const notesSchema = z.string().trim().max(2000).optional();

/** `.strict()`: unknown fields — including `status` — are rejected on create (F21 brief §8: status must not be freely set through create). */
export const createCustomerSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    phone: phoneSchema,
    notes: notesSchema,
  })
  .strict();

export const updateCustomerSchema = z
  .object({
    name: nameSchema.optional(),
    email: emailSchema.nullable(),
    phone: phoneSchema.nullable(),
    notes: notesSchema.nullable(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .strict();

/** No complex pagination (F20/F21 convention) — a hard, safe cap. `q` searches name/email/phone (F21 brief §6). */
export const listCustomersQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
