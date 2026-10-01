import { z } from "zod";
import { pageFields, pageSizeOrLimit, sortFields } from "../../shared/listing.js";

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
export const CATEGORIES_DEFAULT_PAGE_SIZE = 50;
export const listCategoriesQuerySchema = z
  .object({
    status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
    ...pageFields(CATEGORIES_DEFAULT_PAGE_SIZE, 100),
    ...sortFields(["createdAt", "name"], "createdAt", "desc"),
  })
  .strict()
  .refine(...pageSizeOrLimit);
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
