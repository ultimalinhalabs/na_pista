import { z } from "zod";
import { pageFields, pageSizeOrLimit, sortFields } from "../../shared/listing.js";
import { quantitySchema } from "../inventory/schemas.js";

const uuidSchema = z.string().uuid();

/**
 * F23 brief §13/§14/§33: a client supplies only `productId` and
 * `quantity` — `unitPrice`/`productName`/`subtotal` are always
 * server-derived from the current `Product` at the moment the item is
 * created (ADR-031), never accepted from the request. `.strict()` rejects
 * any attempt to submit them (or `id`/`organizationId`/`orderId`).
 */
const orderItemInputSchema = z
  .object({
    productId: uuidSchema,
    quantity: quantitySchema,
  })
  .strict();

/**
 * `items` defaults to an empty array — a DRAFT Order may be created empty
 * and built up via the dedicated item endpoints, or created with items
 * inline in one call; either is valid (F23 brief doesn't mandate one
 * shape). Confirmation (not creation) is where "must have at least one
 * item" is enforced (F23 brief §17 step 3) — see `orders/service.ts`.
 * `currency`/`subtotal`/`total`/`organizationId`/`status` are never
 * accepted from the client (`.strict()`) — all server-derived (ADR-030).
 */
export const createOrderSchema = z
  .object({
    customerId: uuidSchema.optional(),
    items: z.array(orderItemInputSchema).max(100).default([]),
  })
  .strict();

export const addOrderItemSchema = orderItemInputSchema;

export const updateOrderItemSchema = z
  .object({
    quantity: quantitySchema,
  })
  .strict();

/**
 * `PATCH .../orders/:orderId` — DRAFT-only (enforced in the service
 * layer), currently only the customer association is editable this way;
 * item changes go through their own sub-resource endpoints (F23 brief
 * §16/§23). `null` explicitly clears the customer (an assigned Order can
 * become anonymous again while still DRAFT).
 */
export const updateOrderSchema = z
  .object({
    customerId: uuidSchema.nullable().optional(),
  })
  .strict();

export const ORDERS_DEFAULT_PAGE_SIZE = 50;
export const listOrdersQuerySchema = z
  .object({
    status: z.enum(["DRAFT", "CONFIRMED", "COMPLETED", "CANCELED"]).optional(),
    customerId: uuidSchema.optional(),
    ...pageFields(ORDERS_DEFAULT_PAGE_SIZE, 100),
    ...sortFields(["createdAt", "updatedAt"], "createdAt", "desc"),
  })
  .strict()
  .refine(...pageSizeOrLimit);
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
