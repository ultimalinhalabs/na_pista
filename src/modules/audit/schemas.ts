import { z } from "zod";
import { pageFields, pageSizeOrLimit } from "../../shared/listing.js";

export const AUDIT_DEFAULT_PAGE_SIZE = 50;

/** Identifiers as written by Na Pista code, e.g. `product.created`, `inventory.receipt`. */
const identifier = z.string().regex(/^[a-z][a-z0-9_.]{0,99}$/, "Must be a lowercase identifier (letters, digits, _ and .)");

/**
 * ADR-055: equality/range filters on indexed columns only — no JSON
 * querying of `metadata`, no free-text search.
 */
export const listAuditEventsQuerySchema = z
  .object({
    action: identifier.optional().meta({ description: "Exact action, e.g. `order.confirmed`." }),
    actorType: z.enum(["user", "service"]).optional(),
    resourceType: identifier.optional().meta({ description: "Exact resource type, e.g. `product`." }),
    resourceId: z.string().min(1).max(200).optional().meta({ description: "Exact resource id." }),
    from: z.iso.datetime({ offset: true }).optional().meta({ description: "Inclusive lower bound on createdAt (ISO-8601)." }),
    to: z.iso
      .datetime({ offset: true })
      .optional()
      .meta({ description: "Exclusive upper bound on createdAt. Pin it to your first request's time for stable paging." }),
    ...pageFields(AUDIT_DEFAULT_PAGE_SIZE, 100),
  })
  .strict()
  .refine(...pageSizeOrLimit)
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), { message: "to must be after from", path: ["to"] });
export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;
