/** Same envelope/codes convention as ul-platform (api-boundary.md §2), plus Na Pista's own codes. */
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

/** Na Pista-specific: module not enabled by the organization's current entitlements. Fail closed. */
export class EntitlementRequiredError extends AppError {
  constructor(message = "This capability is not enabled for this organization") {
    super(403, "ENTITLEMENT_REQUIRED", message);
  }
}

/** Na Pista-specific: a local state limit (e.g. products.max) has been reached. */
export class LimitExceededError extends AppError {
  constructor(message = "Limit exceeded") {
    super(409, "LIMIT_EXCEEDED", message);
  }
}

/** The Platform (or this spike's own DB) could not be reached / did not answer in time. Fail closed, never silently allow. */
export class UpstreamUnavailableError extends AppError {
  constructor(message = "A required upstream dependency is unavailable") {
    super(503, "UPSTREAM_UNAVAILABLE", message);
  }
}
