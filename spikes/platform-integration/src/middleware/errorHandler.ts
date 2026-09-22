import type { NextFunction, Request, Response } from "express";
import { AppError, UpstreamUnavailableError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { fail } from "../shared/response.js";

/**
 * Postgres/network connection failures from Na Pista's OWN database — fail
 * closed as 503, never a leaked 500 (F19 §19 "Database unavailable").
 * drizzle-orm wraps the driver's raw error inside `DrizzleQueryError`,
 * which does not itself expose `.code` — the real one is nested in
 * `.cause` (same shape ul-platform's own `shared/errors.ts` already
 * documents and walks for the exact same reason).
 */
function extractErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  if ("cause" in error) return extractErrorCode((error as { cause: unknown }).cause);
  return undefined;
}
function isConnectionError(error: unknown): boolean {
  const code = extractErrorCode(error);
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "CONNECTION_ENDED" || code === "CONNECT_TIMEOUT";
}

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

  logger.error("http.request.unhandled_error", {
    requestId: req.requestId,
    path: req.path,
    message: error instanceof Error ? error.message : String(error),
  });
  return fail(res, 500, "INTERNAL_ERROR", "Unexpected error");
}
