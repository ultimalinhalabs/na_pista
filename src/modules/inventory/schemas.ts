import { z } from "zod";

/**
 * F22 brief §4/§29: quantity is precise decimal (`numeric(20,6)` in
 * Postgres), never floating-point arithmetic on the way in. Accepts a
 * JSON number or a decimal string (same duality ul-platform's own usage
 * module already established for exactly this reason — a JSON number is
 * an IEEE-754 double, so a large/precise value round-tripped through one
 * would reintroduce the imprecision numeric(20,6) exists to avoid) and
 * always normalizes to a fixed 6-decimal STRING before it ever reaches
 * Postgres. Rejects NaN, Infinity, zero, negative input (direction comes
 * from `type`, never from sign — F22 brief §11), and precision/magnitude
 * that would not fit `numeric(20,6)` (14 integer digits, 6 decimal).
 */
const MAX_QUANTITY = 999_999_999_999.999999; // 14 integer digits, 6 decimal — numeric(20,6)'s ceiling

const quantitySchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const num = typeof value === "string" ? Number(value) : value;
    if (!Number.isFinite(num)) {
      ctx.addIssue({ code: "custom", message: "quantity must be a finite number (no NaN/Infinity)" });
      return z.NEVER;
    }
    if (num <= 0) {
      ctx.addIssue({ code: "custom", message: "quantity must be a positive, non-zero number — direction comes from the movement type, never a negative quantity" });
      return z.NEVER;
    }
    if (num > MAX_QUANTITY) {
      ctx.addIssue({ code: "custom", message: `quantity exceeds the maximum representable value (${MAX_QUANTITY})` });
      return z.NEVER;
    }
    // Normalize to a fixed 6-decimal string — never let a JS double reach Postgres directly.
    return num.toFixed(6);
  });

export const createMovementSchema = z
  .object({
    type: z.enum(["RECEIPT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"]),
    quantity: quantitySchema,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * `zeroStock` (quantity === 0) is well-defined and offered. `lowStock` is
 * deliberately NOT offered: it would require a per-product minimum-stock
 * threshold, a field this slice's Product model does not have and no
 * requirement asked for (F22 brief §16 "if the business model supports
 * it" — it doesn't yet). Documented as a deferred decision, not silently
 * dropped (see docs/f22-report.md).
 */
export const listInventoryQuerySchema = z
  .object({
    zeroStock: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();

export const listMovementsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
