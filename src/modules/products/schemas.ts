import { z } from "zod";

const uuidSchema = z.string().uuid();

/** ADR-027 (F22): minimal fixed unit enum, lives on Product — see db/schema/products.ts. */
const unitSchema = z.enum(["UNIT", "KG", "G", "L", "ML"]);

/**
 * ADR-029/ADR-031 (F23): money, never a float. Accepts a JSON number or a
 * decimal string (same duality `quantity` already has), rejects
 * NaN/Infinity/negative, always normalizes to a fixed 2-decimal string
 * before it reaches Postgres. `0` is explicitly valid (a deliberately free
 * product) — only negative/non-finite input is rejected.
 */
const priceSchema = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const num = typeof value === "string" ? Number(value) : value;
    if (!Number.isFinite(num)) {
      ctx.addIssue({ code: "custom", message: "price must be a finite number (no NaN/Infinity)" });
      return z.NEVER;
    }
    if (num < 0) {
      ctx.addIssue({ code: "custom", message: "price must not be negative" });
      return z.NEVER;
    }
    return num.toFixed(2);
  });

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    categoryId: uuidSchema.optional(),
    unit: unitSchema.optional(),
    price: priceSchema.optional(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    categoryId: uuidSchema.nullable().optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    unit: unitSchema.optional(),
    // Nullable: explicitly clearing a price back to "not yet priced" (ADR-031) is a valid operation.
    price: priceSchema.nullable().optional(),
  })
  .strict();

/** F20 brief §23/§30: basic search + filters, a hard safe limit — no full pagination, no full-text search engine. */
export const listProductsQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    categoryId: uuidSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
