import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, extractErrorCode, isConnectionError, isExclusionViolationError, isUniqueViolationError, UpstreamUnavailableError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { fail } from "../shared/response.js";

/** Same envelope everywhere, same "never leak internals" posture as ul-platform's own errorHandler.ts. */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
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
    return fail(res, error.statusCode, error.code, error.message);
  }

  if (error instanceof ZodError) {
    logger.info("http.request.error", { requestId: req.requestId, errorCode: "VALIDATION_ERROR", status: 400, path: req.path });
    return fail(res, 400, "VALIDATION_ERROR", "Invalid request payload");
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
