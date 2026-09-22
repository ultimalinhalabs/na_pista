import { z } from "zod";

const uuidSchema = z.string().uuid();

export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    categoryId: uuidSchema.optional(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    categoryId: uuidSchema.nullable().optional(),
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
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
