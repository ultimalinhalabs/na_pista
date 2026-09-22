import { z } from "zod";

/** `.strict()`: unknown fields are rejected, not silently ignored — F20 brief §16. */
export const createCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
  })
  .strict();

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  })
  .strict();

/** No complex pagination in this slice (F20 brief §30/§23) — a hard, safe cap instead. */
export const listCategoriesQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    limit: z.coerce.number().int().positive().max(100).default(50),
  })
  .strict();
