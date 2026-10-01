import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import {
  AppError,
  extractErrorCode,
  isConnectionError,
  isExclusionViolationError,
  isInvalidTextRepresentationError,
  isUniqueViolationError,
  NotFoundError,
  PayloadTooLargeError,
  UpstreamUnavailableError,
  ValidationError,
} from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { fail } from "../shared/response.js";
import { toValidationIssues } from "../shared/validate.js";

/** ADR-053: any route nothing matched — JSON, never Express's HTML page. */
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError("Route not found"));
}

/** body-parser failures carry `type` (e.g. "entity.parse.failed", "entity.too.large") — never their message (it can quote the body). */
function bodyParserError(error: unknown): AppError | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  const type = (error as { type?: unknown }).type;
  if (type === "entity.too.large") return new PayloadTooLargeError();
  if (typeof type === "string" && type.startsWith("entity.")) return new ValidationError("Malformed JSON body", [{ location: "body", path: "", message: "Body is not valid JSON" }]);
  if (typeof type === "string" && (type === "encoding.unsupported" || type === "charset.unsupported")) return new ValidationError("Unsupported body encoding");
  return undefined;
}

/** Same envelope everywhere, same "never leak internals" posture as ul-platform's own errorHandler.ts. */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const parseError = bodyParserError(error);
  if (parseError) error = parseError;

  if (isConnectionError(error)) {
    const mapped = new UpstreamUnavailableError("Na Pista's own database is unavailable");
    logger.info("http.request.error", { requestId: req.requestId, errorCode: mapped.code, status: mapped.statusCode, path: req.path });
    return fail(res, mapped.statusCode, mapped.code, mapped.message);
  }

  if (error instanceof AppError) {
    logger.info("http.request.error", {
      requestId: req.requestId,
      errorCode: error.code,
      status: error.statusCode,
      path: req.path,
    });
    return fail(res, error.statusCode, error.code, error.message, error.details);
  }

  // A schema parsed outside the route boundary helpers (parseBody/parseQuery) — location unknown.
  if (error instanceof ZodError) {
    logger.info("http.request.error", { requestId: req.requestId, errorCode: "VALIDATION_ERROR", status: 400, path: req.path });
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request payload", toValidationIssues(error));
  }

  // ADR-053 backstop: a malformed value reached a typed column (paths are validated earlier; this should not happen).
  if (isInvalidTextRepresentationError(error)) {
    logger.info("http.request.error", { requestId: req.requestId, errorCode: "VALIDATION_ERROR", status: 400, path: req.path });
    return fail(res, 400, "VALIDATION_ERROR", "Invalid identifier or value");
  }

  if (isUniqueViolationError(error)) {
    logger.info("http.request.error", { requestId: req.requestId, errorCode: "CONFLICT", status: 409, path: req.path });
    return fail(res, 409, "CONFLICT", "Resource already exists");
  }

  // F27 (ADR-044): defense in depth — any exclusion violation a domain
  // service did not already translate is still a 409, never a 500 that
  // might tempt someone to log/return the raw constraint details.
  if (isExclusionViolationError(error)) {
    logger.info("http.request.error", { requestId: req.requestId, errorCode: "CONFLICT", status: 409, path: req.path });
    return fail(res, 409, "CONFLICT", "Conflicting resource state");
  }

  logger.error("http.request.unhandled_error", {
    requestId: req.requestId,
    path: req.path,
    // SQLSTATE/driver code only (e.g. "40P01") — server log, never the response body.
    code: extractErrorCode(error),
    message: error instanceof Error ? error.message : String(error),
  });
  return fail(res, 500, "INTERNAL_ERROR", "Unexpected error");
}
