import { z } from "zod";

/**
 * ADR-054: the public RESPONSE contract, in the same schema system as the
 * request validation (Zod). Strict objects: tests parse real responses with
 * these, so a field the server returns but the contract does not document
 * fails a test. (The published OpenAPI relaxes `additionalProperties` on
 * responses so clients tolerate future additive fields.)
 *
 * Shapes mirror what the services actually return today — mostly the stored
 * row, camelCased — never more.
 */

export const Uuid = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true }).meta({ description: "ISO-8601 date-time (UTC)." });
export const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).meta({ description: "Organization-local date, YYYY-MM-DD." });
export const LocalTime = z.string().regex(/^\d{2}:\d{2}$/).meta({ description: "Organization-local time, HH:mm." });
export const Decimal = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .meta({ description: "Exact decimal as a string (money: 2 decimal places; quantities: 6). Never a float." });
const ActiveArchived = z.enum(["ACTIVE", "ARCHIVED"]);

// ---------------------------------------------------------------- envelope

export const ValidationIssueSchema = z
  .strictObject({
    location: z.enum(["body", "query", "path"]).optional(),
    path: z.string().meta({ description: "Dotted path of the invalid field in the client's input (empty = the whole body)." }),
    message: z.string(),
  })
  .meta({ id: "ValidationIssue" });

export const ErrorResponseSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.string().meta({ description: "Stable machine-readable code. Branch on this, then on the HTTP status." }),
      message: z.string().meta({ description: "Human-readable; not part of the contract (may change)." }),
      details: z.array(ValidationIssueSchema).optional().meta({ description: "Present on VALIDATION_ERROR when field-level information exists." }),
    }),
  })
  .meta({ id: "ErrorResponse" });

export const PaginationSchema = z
  .strictObject({
    page: z.int().min(1),
    pageSize: z.int().min(1),
    total: z.int().min(0).meta({ description: "Rows matching the filters at query time (tenant-scoped)." }),
    totalPages: z.int().min(0),
  })
  .meta({ id: "Pagination" });

export const RemovedSchema = z.strictObject({ removed: z.literal(true) }).meta({ id: "Removed" });
export const HealthSchema = z.strictObject({ status: z.literal("ok") }).meta({ id: "Health" });
export const ReadinessSchema = z.strictObject({ status: z.literal("ready") }).meta({ id: "Readiness" });
export const OpenApiDocumentSchema = z
  .looseObject({ openapi: z.string(), info: z.looseObject({}), paths: z.looseObject({}) })
  .meta({ id: "OpenApiDocument", description: "This document (OpenAPI 3.1)." });

// --------------------------------------------------------------- catalogue

export const CategorySchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    status: ActiveArchived,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Category" });

export const ProductSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    categoryId: Uuid.nullable(),
    name: z.string(),
    description: z.string().nullable(),
    status: ActiveArchived,
    unit: z.enum(["UNIT", "KG", "G", "L", "ML"]),
    price: Decimal.nullable().meta({ description: "null = not yet priced (cannot be ordered); \"0.00\" = deliberately free." }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Product" });

export const CustomerSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    notes: z.string().nullable(),
    status: ActiveArchived,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Customer" });

// --------------------------------------------------------------- inventory

const balanceFields = {
  id: Uuid,
  organizationId: Uuid,
  productId: Uuid,
  quantity: Decimal,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

export const InventoryBalanceSchema = z
  .strictObject({
    ...balanceFields,
    productName: z.string(),
    productUnit: z.enum(["UNIT", "KG", "G", "L", "ML"]),
    productStatus: ActiveArchived,
  })
  .meta({ id: "InventoryBalance" });

export const StockMovementSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    inventoryId: Uuid,
    productId: Uuid,
    type: z.enum(["RECEIPT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"]),
    quantity: Decimal,
    reason: z.string().nullable(),
    actorType: z.enum(["user", "service"]),
    actorId: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: "StockMovement" });

export const StockMovementResultSchema = z
  .strictObject({
    balance: z.strictObject(balanceFields),
    movement: StockMovementSchema,
  })
  .meta({ id: "StockMovementResult" });

// ------------------------------------------------------------------ orders

export const OrderSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    customerId: Uuid.nullable(),
    status: z.enum(["DRAFT", "CONFIRMED", "COMPLETED", "CANCELED"]),
    currency: z.string().meta({ description: "Organization currency at creation (AOA)." }),
    subtotal: Decimal,
    total: Decimal,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Order", description: "List view — no items." });

export const OrderItemSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    orderId: Uuid,
    productId: Uuid,
    productName: z.string().meta({ description: "Snapshot at the time the item was added." }),
    quantity: Decimal,
    unitPrice: Decimal.meta({ description: "Snapshot of Product.price; later price changes never affect it." }),
    subtotal: Decimal,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "OrderItem" });

export const OrderDetailSchema = OrderSchema.extend({ items: z.array(OrderItemSchema) }).meta({ id: "OrderDetail" });

// ------------------------------------------------------- services/booking

export const ServiceSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    durationMinutes: z.int().positive(),
    price: Decimal.nullable(),
    status: ActiveArchived,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Service" });

export const ProfessionalSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    status: ActiveArchived,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Professional" });

export const ProfessionalServiceAssociationSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    professionalId: Uuid,
    serviceId: Uuid,
    createdAt: Timestamp,
  })
  .meta({ id: "ProfessionalServiceAssociation" });

export const AssociatedServiceSchema = z
  .strictObject({
    id: Uuid,
    name: z.string(),
    durationMinutes: z.int().positive(),
    price: Decimal.nullable(),
    status: ActiveArchived,
    associatedAt: Timestamp,
  })
  .meta({ id: "AssociatedService" });

export const ScheduleRuleSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    professionalId: Uuid,
    dayOfWeek: z.int().min(0).max(6).meta({ description: "0 = Sunday … 6 = Saturday." }),
    startLocalTime: LocalTime,
    endLocalTime: LocalTime,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ScheduleRule" });

export const ScheduleExceptionSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    professionalId: Uuid,
    date: LocalDate,
    startLocalTime: LocalTime.nullable().meta({ description: "null with endLocalTime null = closed all day." }),
    endLocalTime: LocalTime.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "ScheduleException" });

export const AvailabilitySchema = z
  .strictObject({
    timezone: z.string(),
    days: z.array(
      z.strictObject({
        date: LocalDate,
        workingIntervals: z.array(z.strictObject({ start: LocalTime, end: LocalTime })),
        serviceStartTimes: z.array(LocalTime).optional().meta({ description: "Present only when serviceId is given." }),
      }),
    ),
  })
  .meta({ id: "Availability" });

export const OrganizationSettingsSchema = z
  .strictObject({
    organizationId: Uuid,
    timezone: z.string().meta({ description: "IANA time zone, e.g. Africa/Luanda." }),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "OrganizationSettings" });

export const AppointmentSchema = z
  .strictObject({
    id: Uuid,
    organizationId: Uuid,
    customerId: Uuid,
    professionalId: Uuid,
    serviceId: Uuid,
    startAt: Timestamp,
    endAt: Timestamp,
    durationMinutes: z.int().positive(),
    status: z.enum(["SCHEDULED", "COMPLETED", "CANCELED", "NO_SHOW"]),
    serviceName: z.string().meta({ description: "Snapshot at booking time." }),
    servicePrice: Decimal.nullable().meta({ description: "Snapshot at booking time." }),
    currency: z.string(),
    notes: z.string().nullable(),
    cancellationReason: z.string().nullable(),
    canceledAt: Timestamp.nullable(),
    completedAt: Timestamp.nullable(),
    noShowAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Appointment" });

export const BookableSlotsSchema = z
  .strictObject({
    timezone: z.string(),
    date: LocalDate,
    serviceId: Uuid,
    durationMinutes: z.int().positive(),
    slots: z.array(z.strictObject({ localStartTime: LocalTime, startAt: Timestamp, endAt: Timestamp })),
  })
  .meta({ id: "BookableSlots" });

// --------------------------------------------------- integration metadata

export const AuditEventSchema = z
  .strictObject({
    id: Uuid,
    action: z.string(),
    actorType: z.enum(["user", "service"]),
    actorId: z.string(),
    resourceType: z.string(),
    resourceId: z.string(),
    requestId: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable().meta({ description: "Safe, operation-specific metadata; keys that look like secrets are redacted." }),
    createdAt: Timestamp,
  })
  .meta({ id: "AuditEvent" });

export const PlatformCredentialStatusSchema = z
  .strictObject({
    configured: z.boolean().meta({ description: "A credential record exists for this organization." }),
    status: z.enum(["ACTIVE", "REVOKED"]).nullable(),
    createdAt: Timestamp.nullable(),
    updatedAt: Timestamp.nullable(),
    revokedAt: Timestamp.nullable(),
  })
  .meta({ id: "PlatformCredentialStatus" });

// ---------------------------------------------------------------- helpers

/** `{ "data": T }` */
export function dataEnvelope<T extends z.ZodType>(schema: T) {
  return z.strictObject({ data: schema });
}

/** ADR-051: `{ "data": T[], "pagination": … }` */
export function pageEnvelope<T extends z.ZodType>(schema: T) {
  return z.strictObject({ data: z.array(schema), pagination: PaginationSchema });
}
