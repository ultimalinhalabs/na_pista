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
 *
 * The magnitude check counts digits on the normalized STRING rather than
 * comparing against a float literal constant — a 20-significant-digit
 * value like `numeric(20,6)`'s own ceiling cannot be represented exactly
 * by a JS double in the first place (it would silently round), so a
 * float-literal bound would be both imprecise and misleading.
 *
 * Exported (F23, ADR-032/F23A §8): `OrderItem.quantity` deliberately
 * reuses this exact same representation/validation rather than a parallel
 * one — a future StockMovement created at Order confirmation consumes an
 * OrderItem's quantity directly, so the two must never disagree on
 * precision/shape.
 */
const MAX_INTEGER_DIGITS = 14; // numeric(20,6): 20 total significant digits, 6 of them after the decimal point

export const quantitySchema = z
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
    // Normalize to a fixed 6-decimal string — never let a JS double reach Postgres directly.
    const fixed = num.toFixed(6);
    const integerDigits = fixed.split(".")[0]!.length;
    if (integerDigits > MAX_INTEGER_DIGITS) {
      ctx.addIssue({ code: "custom", message: `quantity exceeds the maximum representable value for numeric(20,6) (${MAX_INTEGER_DIGITS} integer digits)` });
      return z.NEVER;
    }
    return fixed;
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
