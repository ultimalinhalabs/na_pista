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

/** F22 brief §22: a new inventory movement was attempted against an ARCHIVED product. */
export class ProductArchivedError extends AppError {
  constructor(message = "This product is archived; new inventory movements are not allowed") {
    super(409, "PRODUCT_ARCHIVED", message);
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
