import type { z } from "zod";
import {
  cancelAppointmentSchema,
  createAppointmentSchema,
  listAppointmentsQuerySchema,
  bookableSlotsQuerySchema,
  noShowAppointmentSchema,
  updateAppointmentSchema,
} from "../modules/appointments/schemas.js";
import { createCategorySchema, listCategoriesQuerySchema, updateCategorySchema } from "../modules/categories/schemas.js";
import { createCustomerSchema, listCustomersQuerySchema, updateCustomerSchema } from "../modules/customers/schemas.js";
import { createMovementSchema, listInventoryQuerySchema, listMovementsQuerySchema } from "../modules/inventory/schemas.js";
import {
  addOrderItemSchema,
  createOrderSchema,
  listOrdersQuerySchema,
  updateOrderItemSchema,
  updateOrderSchema,
} from "../modules/orders/schemas.js";
import { updateOrganizationSettingsSchema } from "../modules/organizationSettings/schemas.js";
import { createProductSchema, listProductsQuerySchema, updateProductSchema } from "../modules/products/schemas.js";
import { createProfessionalSchema, listProfessionalsQuerySchema, updateProfessionalSchema } from "../modules/professionals/schemas.js";
import { availabilityQuerySchema, createExceptionSchema, replaceScheduleSchema } from "../modules/scheduling/schemas.js";
import { createServiceSchema, listServicesQuerySchema, updateServiceSchema } from "../modules/services/schemas.js";
import {
  AppointmentSchema,
  AssociatedServiceSchema,
  AvailabilitySchema,
  BookableSlotsSchema,
  CategorySchema,
  CustomerSchema,
  HealthSchema,
  OpenApiDocumentSchema,
  InventoryBalanceSchema,
  OrderDetailSchema,
  OrderSchema,
  OrganizationSettingsSchema,
  ProductSchema,
  ProfessionalSchema,
  ProfessionalServiceAssociationSchema,
  RemovedSchema,
  ScheduleExceptionSchema,
  ScheduleRuleSchema,
  ServiceSchema,
  StockMovementResultSchema,
  StockMovementSchema,
} from "./schemas.js";

/**
 * ADR-054: the operation registry — one entry per public route. The OpenAPI
 * document is generated from it, and tests prove it matches the Express
 * router exactly (no undocumented route, no documented phantom).
 *
 * `body`/`query` are the SAME Zod objects the handlers validate with.
 */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

export interface Operation {
  method: HttpMethod;
  /** Express-style path under /v1, e.g. "/organizations/:organizationId/products". */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** "public" = no Authorization header. */
  auth:
    | "public"
    | {
        /** Human permission(s) (Na Pista role map). Several = chosen by the request (see description). */
        permission: string | string[];
        /** Service-credential scope; null = human callers only. */
        scope: string | null;
        /** false = not behind the `catalog.enabled` capability gate. */
        capabilityGate?: boolean;
      };
  query?: z.ZodObject;
  body?: z.ZodType;
  success: {
    status: 200 | 201;
    /** data = { data: T }, list = { data: T[] } (bounded sub-collection), page = ADR-051 envelope, raw = document as-is. */
    kind: "data" | "list" | "page" | "raw";
    schema: z.ZodType;
    nullable?: boolean;
  };
  /** Domain-specific 409 codes, beyond the generic ones (see docs/api/errors.md). */
  conflicts?: string[];
  /** Domain-specific 404 codes, beyond NOT_FOUND. */
  notFound?: string[];
  /** Extra 400 codes beyond VALIDATION_ERROR. */
  badRequest?: string[];
}

const ORG = "/organizations/:organizationId";
const read = (permission: string) => ({ permission, scope: "catalog.read" });
const write = (permission: string) => ({ permission, scope: "catalog.write" });

export const operations: Operation[] = [
  // ------------------------------------------------------------- platform
  {
    method: "get",
    path: "/health",
    tag: "Platform",
    summary: "Liveness check",
    auth: "public",
    success: { status: 200, kind: "data", schema: HealthSchema },
  },
  {
    method: "get",
    path: "/openapi.json",
    tag: "Platform",
    summary: "This API contract (OpenAPI 3.1)",
    description: "Public. Generated from the same schemas the API validates requests with.",
    auth: "public",
    success: { status: 200, kind: "raw", schema: OpenApiDocumentSchema },
  },

  // ----------------------------------------------------------- categories
  { method: "post", path: `${ORG}/categories`, tag: "Categories", summary: "Create a category", auth: write("categories.create"), body: createCategorySchema, success: { status: 201, kind: "data", schema: CategorySchema } },
  { method: "get", path: `${ORG}/categories`, tag: "Categories", summary: "List categories", auth: read("categories.read"), query: listCategoriesQuerySchema, success: { status: 200, kind: "list", schema: CategorySchema } },
  { method: "get", path: `${ORG}/categories/:categoryId`, tag: "Categories", summary: "Get a category", auth: read("categories.read"), success: { status: 200, kind: "data", schema: CategorySchema } },
  { method: "patch", path: `${ORG}/categories/:categoryId`, tag: "Categories", summary: "Update a category", auth: write("categories.update"), body: updateCategorySchema, success: { status: 200, kind: "data", schema: CategorySchema } },
  { method: "delete", path: `${ORG}/categories/:categoryId`, tag: "Categories", summary: "Archive a category", description: "Archives (never physically deletes) and returns the archived category.", auth: write("categories.delete"), success: { status: 200, kind: "data", schema: CategorySchema } },

  // ------------------------------------------------------------- products
  { method: "post", path: `${ORG}/products`, tag: "Products", summary: "Create a product", auth: write("products.create"), body: createProductSchema, success: { status: 201, kind: "data", schema: ProductSchema } },
  { method: "get", path: `${ORG}/products`, tag: "Products", summary: "List products", auth: read("products.read"), query: listProductsQuerySchema, success: { status: 200, kind: "list", schema: ProductSchema } },
  { method: "get", path: `${ORG}/products/:productId`, tag: "Products", summary: "Get a product", auth: read("products.read"), success: { status: 200, kind: "data", schema: ProductSchema } },
  { method: "patch", path: `${ORG}/products/:productId`, tag: "Products", summary: "Update a product", auth: write("products.update"), body: updateProductSchema, success: { status: 200, kind: "data", schema: ProductSchema } },
  { method: "delete", path: `${ORG}/products/:productId`, tag: "Products", summary: "Archive a product", description: "Archives (never physically deletes) and returns the archived product.", auth: write("products.delete"), success: { status: 200, kind: "data", schema: ProductSchema } },

  // ------------------------------------------------------------ customers
  { method: "post", path: `${ORG}/customers`, tag: "Customers", summary: "Create a customer", auth: write("customers.create"), body: createCustomerSchema, success: { status: 201, kind: "data", schema: CustomerSchema } },
  { method: "get", path: `${ORG}/customers`, tag: "Customers", summary: "List customers", auth: read("customers.read"), query: listCustomersQuerySchema, success: { status: 200, kind: "list", schema: CustomerSchema } },
  { method: "get", path: `${ORG}/customers/:customerId`, tag: "Customers", summary: "Get a customer", auth: read("customers.read"), success: { status: 200, kind: "data", schema: CustomerSchema } },
  { method: "patch", path: `${ORG}/customers/:customerId`, tag: "Customers", summary: "Update a customer", auth: write("customers.update"), body: updateCustomerSchema, success: { status: 200, kind: "data", schema: CustomerSchema } },
  { method: "delete", path: `${ORG}/customers/:customerId`, tag: "Customers", summary: "Archive a customer", description: "Archives (never physically deletes) and returns the archived customer.", auth: write("customers.delete"), success: { status: 200, kind: "data", schema: CustomerSchema } },

  // ------------------------------------------------------------ inventory
  { method: "get", path: `${ORG}/inventory`, tag: "Inventory", summary: "List stock balances", auth: read("inventory.read"), query: listInventoryQuerySchema, success: { status: 200, kind: "list", schema: InventoryBalanceSchema } },
  { method: "get", path: `${ORG}/inventory/:productId`, tag: "Inventory", summary: "Get a product's stock balance", auth: read("inventory.read"), notFound: ["PRODUCT_NOT_FOUND", "INVENTORY_NOT_FOUND"], success: { status: 200, kind: "data", schema: InventoryBalanceSchema } },
  { method: "get", path: `${ORG}/inventory/:productId/movements`, tag: "Inventory", summary: "List a product's stock movements", auth: read("inventory.read"), query: listMovementsQuerySchema, notFound: ["PRODUCT_NOT_FOUND"], success: { status: 200, kind: "list", schema: StockMovementSchema } },
  {
    method: "post",
    path: `${ORG}/inventory/:productId/movements`,
    tag: "Inventory",
    summary: "Record a stock movement",
    description: "The permission depends on the body: `RECEIPT` needs `inventory.create`; `ADJUSTMENT_IN`/`ADJUSTMENT_OUT` need `inventory.update`. The balance only ever changes through a movement.",
    auth: { permission: ["inventory.create", "inventory.update"], scope: "catalog.write" },
    body: createMovementSchema,
    notFound: ["PRODUCT_NOT_FOUND", "INVENTORY_NOT_FOUND"],
    conflicts: ["INSUFFICIENT_STOCK", "PRODUCT_ARCHIVED"],
    success: { status: 201, kind: "data", schema: StockMovementResultSchema },
  },

  // --------------------------------------------------------------- orders
  { method: "post", path: `${ORG}/orders`, tag: "Orders", summary: "Create a draft order", description: "Prices, totals, currency and status are always derived by the server.", auth: write("orders.create"), body: createOrderSchema, notFound: ["PRODUCT_NOT_FOUND"], conflicts: ["PRODUCT_ARCHIVED", "PRODUCT_PRICE_REQUIRED", "CUSTOMER_ARCHIVED"], success: { status: 201, kind: "data", schema: OrderDetailSchema } },
  { method: "get", path: `${ORG}/orders`, tag: "Orders", summary: "List orders", description: "List view — items are not included; fetch the order for its items.", auth: read("orders.read"), query: listOrdersQuerySchema, success: { status: 200, kind: "list", schema: OrderSchema } },
  { method: "get", path: `${ORG}/orders/:orderId`, tag: "Orders", summary: "Get an order with its items", auth: read("orders.read"), notFound: ["ORDER_NOT_FOUND"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },
  { method: "patch", path: `${ORG}/orders/:orderId`, tag: "Orders", summary: "Update a draft order", auth: write("orders.update"), body: updateOrderSchema, notFound: ["ORDER_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE", "CUSTOMER_ARCHIVED"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },
  { method: "post", path: `${ORG}/orders/:orderId/items`, tag: "Orders", summary: "Add an item to a draft order", auth: write("orders.update"), body: addOrderItemSchema, notFound: ["ORDER_NOT_FOUND", "PRODUCT_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE", "PRODUCT_ARCHIVED", "PRODUCT_PRICE_REQUIRED"], success: { status: 201, kind: "data", schema: OrderDetailSchema } },
  { method: "patch", path: `${ORG}/orders/:orderId/items/:itemId`, tag: "Orders", summary: "Change an item's quantity", auth: write("orders.update"), body: updateOrderItemSchema, notFound: ["ORDER_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },
  { method: "delete", path: `${ORG}/orders/:orderId/items/:itemId`, tag: "Orders", summary: "Remove an item from a draft order", auth: write("orders.update"), notFound: ["ORDER_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },
  { method: "post", path: `${ORG}/orders/:orderId/confirm`, tag: "Orders", summary: "Confirm an order (DRAFT → CONFIRMED)", description: "Atomically decreases stock for every item; nothing partially commits.", auth: write("orders.update"), notFound: ["ORDER_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE", "EMPTY_ORDER", "INSUFFICIENT_STOCK", "PRODUCT_ARCHIVED"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },
  { method: "post", path: `${ORG}/orders/:orderId/cancel`, tag: "Orders", summary: "Cancel an order", description: "From CONFIRMED, returns exactly the stock the order consumed.", auth: write("orders.update"), notFound: ["ORDER_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },
  { method: "post", path: `${ORG}/orders/:orderId/complete`, tag: "Orders", summary: "Complete an order (CONFIRMED → COMPLETED)", auth: write("orders.update"), notFound: ["ORDER_NOT_FOUND"], conflicts: ["INVALID_ORDER_STATE"], success: { status: 200, kind: "data", schema: OrderDetailSchema } },

  // ------------------------------------------------------------- services
  { method: "post", path: `${ORG}/services`, tag: "Services", summary: "Create a service", auth: write("services.create"), body: createServiceSchema, success: { status: 201, kind: "data", schema: ServiceSchema } },
  { method: "get", path: `${ORG}/services`, tag: "Services", summary: "List services", auth: read("services.read"), query: listServicesQuerySchema, success: { status: 200, kind: "list", schema: ServiceSchema } },
  { method: "get", path: `${ORG}/services/:serviceId`, tag: "Services", summary: "Get a service", auth: read("services.read"), success: { status: 200, kind: "data", schema: ServiceSchema } },
  { method: "patch", path: `${ORG}/services/:serviceId`, tag: "Services", summary: "Update, archive or reactivate a service", auth: write("services.update"), body: updateServiceSchema, success: { status: 200, kind: "data", schema: ServiceSchema } },

  // -------------------------------------------------------- professionals
  { method: "post", path: `${ORG}/professionals`, tag: "Professionals", summary: "Create a professional", auth: write("professionals.create"), body: createProfessionalSchema, success: { status: 201, kind: "data", schema: ProfessionalSchema } },
  { method: "get", path: `${ORG}/professionals`, tag: "Professionals", summary: "List professionals", auth: read("professionals.read"), query: listProfessionalsQuerySchema, success: { status: 200, kind: "list", schema: ProfessionalSchema } },
  { method: "get", path: `${ORG}/professionals/:professionalId`, tag: "Professionals", summary: "Get a professional", auth: read("professionals.read"), success: { status: 200, kind: "data", schema: ProfessionalSchema } },
  { method: "patch", path: `${ORG}/professionals/:professionalId`, tag: "Professionals", summary: "Update, archive or reactivate a professional", auth: write("professionals.update"), body: updateProfessionalSchema, success: { status: 200, kind: "data", schema: ProfessionalSchema } },
  { method: "get", path: `${ORG}/professionals/:professionalId/services`, tag: "Professionals", summary: "List the services a professional provides", description: "Bounded sub-collection (at most the organization's services); not paginated.", auth: read("professionals.read"), success: { status: 200, kind: "list", schema: AssociatedServiceSchema } },
  { method: "post", path: `${ORG}/professionals/:professionalId/services/:serviceId`, tag: "Professionals", summary: "Associate a service with a professional", auth: write("professionals.update"), conflicts: ["PROFESSIONAL_ARCHIVED", "SERVICE_ARCHIVED"], success: { status: 201, kind: "data", schema: ProfessionalServiceAssociationSchema } },
  { method: "delete", path: `${ORG}/professionals/:professionalId/services/:serviceId`, tag: "Professionals", summary: "Remove a service from a professional", auth: write("professionals.update"), success: { status: 200, kind: "data", schema: RemovedSchema } },

  // ----------------------------------------------------------- scheduling
  { method: "get", path: `${ORG}/settings`, tag: "Scheduling", summary: "Get organization settings (timezone)", description: "`data` is null until a timezone has been configured.", auth: read("scheduling.read"), success: { status: 200, kind: "data", schema: OrganizationSettingsSchema, nullable: true } },
  { method: "put", path: `${ORG}/settings`, tag: "Scheduling", summary: "Set the organization timezone", auth: write("scheduling.update"), body: updateOrganizationSettingsSchema, success: { status: 200, kind: "data", schema: OrganizationSettingsSchema } },
  { method: "get", path: `${ORG}/professionals/:professionalId/schedule`, tag: "Scheduling", summary: "Get a professional's weekly schedule", description: "A small weekly rule set; not paginated.", auth: read("scheduling.read"), success: { status: 200, kind: "list", schema: ScheduleRuleSchema } },
  { method: "put", path: `${ORG}/professionals/:professionalId/schedule`, tag: "Scheduling", summary: "Replace a professional's weekly schedule", auth: write("scheduling.update"), body: replaceScheduleSchema, success: { status: 200, kind: "list", schema: ScheduleRuleSchema } },
  { method: "get", path: `${ORG}/professionals/:professionalId/schedule/exceptions`, tag: "Scheduling", summary: "List a professional's date exceptions", description: "Not paginated (returns the full set).", auth: read("scheduling.read"), success: { status: 200, kind: "list", schema: ScheduleExceptionSchema } },
  { method: "post", path: `${ORG}/professionals/:professionalId/schedule/exceptions`, tag: "Scheduling", summary: "Add a date exception (time off or extra hours)", auth: write("scheduling.create"), body: createExceptionSchema, success: { status: 201, kind: "data", schema: ScheduleExceptionSchema } },
  { method: "delete", path: `${ORG}/professionals/:professionalId/schedule/exceptions/:exceptionId`, tag: "Scheduling", summary: "Remove a date exception", auth: write("scheduling.update"), success: { status: 200, kind: "data", schema: RemovedSchema } },
  { method: "get", path: `${ORG}/professionals/:professionalId/availability`, tag: "Scheduling", summary: "Compute working intervals (and service start times)", auth: read("scheduling.read"), query: availabilityQuerySchema, conflicts: ["TIMEZONE_NOT_CONFIGURED", "PROFESSIONAL_ARCHIVED", "SERVICE_ARCHIVED"], success: { status: 200, kind: "data", schema: AvailabilitySchema } },

  // --------------------------------------------------------- appointments
  { method: "post", path: `${ORG}/appointments`, tag: "Appointments", summary: "Book an appointment", description: "End time is derived from the service duration; the start must be a bookable slot.", auth: write("appointments.create"), body: createAppointmentSchema, badRequest: ["BOOKING_HORIZON_EXCEEDED"], conflicts: ["APPOINTMENT_CONFLICT", "APPOINTMENT_OUTSIDE_AVAILABILITY", "TIMEZONE_NOT_CONFIGURED", "CUSTOMER_ARCHIVED", "PROFESSIONAL_ARCHIVED", "SERVICE_ARCHIVED"], success: { status: 201, kind: "data", schema: AppointmentSchema } },
  { method: "get", path: `${ORG}/appointments`, tag: "Appointments", summary: "List appointments in a date range", description: "`from`/`to` are required organization-local dates, at most 31 days apart.", auth: read("appointments.read"), query: listAppointmentsQuerySchema, success: { status: 200, kind: "list", schema: AppointmentSchema } },
  { method: "get", path: `${ORG}/appointments/:appointmentId`, tag: "Appointments", summary: "Get an appointment", auth: read("appointments.read"), notFound: ["APPOINTMENT_NOT_FOUND"], success: { status: 200, kind: "data", schema: AppointmentSchema } },
  { method: "patch", path: `${ORG}/appointments/:appointmentId`, tag: "Appointments", summary: "Reschedule or edit an appointment", auth: write("appointments.update"), body: updateAppointmentSchema, notFound: ["APPOINTMENT_NOT_FOUND"], badRequest: ["BOOKING_HORIZON_EXCEEDED"], conflicts: ["INVALID_APPOINTMENT_STATE", "APPOINTMENT_CONFLICT", "APPOINTMENT_OUTSIDE_AVAILABILITY", "TIMEZONE_NOT_CONFIGURED", "PROFESSIONAL_ARCHIVED", "SERVICE_ARCHIVED", "CUSTOMER_ARCHIVED"], success: { status: 200, kind: "data", schema: AppointmentSchema } },
  { method: "post", path: `${ORG}/appointments/:appointmentId/cancel`, tag: "Appointments", summary: "Cancel an appointment", auth: write("appointments.update"), body: cancelAppointmentSchema, notFound: ["APPOINTMENT_NOT_FOUND"], conflicts: ["INVALID_APPOINTMENT_STATE"], success: { status: 200, kind: "data", schema: AppointmentSchema } },
  { method: "post", path: `${ORG}/appointments/:appointmentId/complete`, tag: "Appointments", summary: "Complete an appointment", auth: write("appointments.update"), notFound: ["APPOINTMENT_NOT_FOUND"], conflicts: ["INVALID_APPOINTMENT_STATE", "APPOINTMENT_COMPLETION_TOO_EARLY"], success: { status: 200, kind: "data", schema: AppointmentSchema } },
  { method: "post", path: `${ORG}/appointments/:appointmentId/no-show`, tag: "Appointments", summary: "Mark an appointment as a no-show", auth: write("appointments.update"), body: noShowAppointmentSchema, notFound: ["APPOINTMENT_NOT_FOUND"], conflicts: ["INVALID_APPOINTMENT_STATE", "APPOINTMENT_NO_SHOW_TOO_EARLY"], success: { status: 200, kind: "data", schema: AppointmentSchema } },
  { method: "get", path: `${ORG}/professionals/:professionalId/bookable-slots`, tag: "Appointments", summary: "List bookable start times for a service on a date", auth: read("appointments.read"), query: bookableSlotsQuerySchema, conflicts: ["TIMEZONE_NOT_CONFIGURED"], success: { status: 200, kind: "data", schema: BookableSlotsSchema } },
];
