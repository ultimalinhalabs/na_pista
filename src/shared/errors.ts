/** Same envelope/codes convention as ul-platform and the F19 spike — api-boundary.md §2. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request") {
    super(400, "VALIDATION_ERROR", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Insufficient permissions") {
    super(403, "FORBIDDEN", message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicting resource state") {
    super(409, "CONFLICT", message);
  }
}

/** Module not enabled by the organization's current entitlements. Fail closed. */
export class EntitlementRequiredError extends AppError {
  constructor(message = "This capability is not enabled for this organization") {
    super(403, "ENTITLEMENT_REQUIRED", message);
  }
}

/** A local state limit (e.g. a future products.max) has been reached. */
export class LimitExceededError extends AppError {
  constructor(message = "Limit exceeded") {
    super(409, "LIMIT_EXCEEDED", message);
  }
}

/** The Platform (or Na Pista's own DB) could not be reached / did not answer in time. Fail closed, never silently allow. */
export class UpstreamUnavailableError extends AppError {
  constructor(message = "A required upstream dependency is unavailable") {
    super(503, "UPSTREAM_UNAVAILABLE", message);
  }
}

/** F22: the product referenced by an inventory operation does not exist in this tenant. Distinct from a generic NotFoundError so a client can tell "no such product" apart from "no such inventory record" (F22 brief §30). */
export class ProductNotFoundError extends AppError {
  constructor(message = "Product not found") {
    super(404, "PRODUCT_NOT_FOUND", message);
  }
}

/** F22: no inventory balance has ever been recorded for this product (no RECEIPT yet) — distinct from PRODUCT_NOT_FOUND. */
export class InventoryNotFoundError extends AppError {
  constructor(message = "No inventory recorded for this product") {
    super(404, "INVENTORY_NOT_FOUND", message);
  }
}

/** F22 ADR-028: a stock decrease that would take the balance below zero. The operation fails atomically — no partial movement, no balance change. */
export class InsufficientStockError extends AppError {
  constructor(message = "Insufficient stock for this movement") {
    super(409, "INSUFFICIENT_STOCK", message);
  }
}

/** F22 brief §22: a new inventory movement was attempted against an ARCHIVED product. Reused unchanged by F23 Orders (ADR-032/F23 brief §36) — an archived product can never be added to a new DRAFT Order, and confirmation of a DRAFT Order whose product was archived in the meantime fails with this same error, for free, via `createMovement`. */
export class ProductArchivedError extends AppError {
  constructor(message = "This product is archived; new inventory movements are not allowed") {
    super(409, "PRODUCT_ARCHIVED", message);
  }
}

/** F23 (ADR-031): Product.price is NULL — a product without a price cannot be added to an Order. Distinct from ProductNotFoundError/ProductArchivedError so a client can tell "exists, sellable, but unpriced" apart from those. */
export class ProductPriceRequiredError extends AppError {
  constructor(message = "This product has no price set; it cannot be added to an Order") {
    super(409, "PRODUCT_PRICE_REQUIRED", message);
  }
}

/** F23 brief §37: a new Order (or a DRAFT Order's customer change) may not select an archived Customer. Historical Orders that already reference one remain valid — this error only fires on the write path that assigns a customer. */
export class CustomerArchivedError extends AppError {
  constructor(message = "This customer is archived; it cannot be assigned to a new Order") {
    super(409, "CUSTOMER_ARCHIVED", message);
  }
}

/** F23: the Order referenced does not exist in this tenant. */
export class OrderNotFoundError extends AppError {
  constructor(message = "Order not found") {
    super(404, "ORDER_NOT_FOUND", message);
  }
}

/**
 * F23 (ADR-032): a lifecycle operation was attempted from a state that does
 * not allow it — e.g. confirming an already-CONFIRMED/terminal Order,
 * editing a non-DRAFT Order, completing a non-CONFIRMED Order. Also the
 * guard a second, racing lifecycle request lands on (F23 brief §22/§44):
 * the underlying transition is a single atomic conditional statement, so a
 * duplicate/concurrent request that loses the race gets this error, never
 * a silent no-op and never a double-applied side effect.
 */
export class InvalidOrderStateError extends AppError {
  constructor(message = "This operation is not valid for the Order's current state") {
    super(409, "INVALID_ORDER_STATE", message);
  }
}

/** F23 brief §17: an Order with no items cannot be confirmed. */
export class EmptyOrderError extends AppError {
  constructor(message = "An Order with no items cannot be confirmed") {
    super(409, "EMPTY_ORDER", message);
  }
}

/** F25 (ADR-037): a new professional_services association may not be created against an ARCHIVED Professional — a new capability should not be configured onto a resource being wound down. Existing associations are unaffected (they are never removed by archiving). */
export class ProfessionalArchivedError extends AppError {
  constructor(message = "This professional is archived; new service associations are not allowed") {
    super(409, "PROFESSIONAL_ARCHIVED", message);
  }
}

/** F25 (ADR-037): a new professional_services association may not be created against an ARCHIVED Service — mirrors ProductArchivedError's exact reasoning (ADR-028), applied to the Professional/Service catalog relationship. */
export class ServiceArchivedError extends AppError {
  constructor(message = "This service is archived; new professional associations are not allowed") {
    super(409, "SERVICE_ARCHIVED", message);
  }
}

/**
 * Postgres unique_violation (23505) walked through drizzle-orm's
 * `DrizzleQueryError.cause` chain — same pattern ul-platform's own
 * shared/errors.ts documents (drizzle wraps the driver's raw error and
 * does not itself expose `.code`).
 */
export function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  if ("cause" in error) return extractErrorCode((error as { cause: unknown }).cause);
  return undefined;
}

export function isUniqueViolationError(error: unknown): boolean {
  return extractErrorCode(error) === "23505";
}

export function isConnectionError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "CONNECTION_ENDED" || code === "CONNECT_TIMEOUT";
}
