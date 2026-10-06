import type { NextFunction, Request, Response, Router } from "express";
import { ValidationError } from "./errors.js";

export function paramString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every `:…Id` path segment in the public API is a UUID primary key. */
const UUID_PARAMS = [
  "organizationId",
  "categoryId",
  "productId",
  "customerId",
  "orderId",
  "itemId",
  "serviceId",
  "professionalId",
  "exceptionId",
  "appointmentId",
] as const;

/**
 * ADR-053: a malformed id is a client error (400, `location: "path"`), never
 * a database round trip that fails with 22P02 and surfaces as a 500. Runs
 * after authentication and before tenant resolution.
 */
export function validateUuidParams(router: Router) {
  for (const name of UUID_PARAMS) {
    router.param(name, (_req: Request, _res: Response, next: NextFunction, value: unknown) => {
      if (typeof value === "string" && UUID.test(value)) return next();
      next(new ValidationError("Invalid request payload", [{ location: "path", path: name, message: "Must be a valid UUID" }]));
    });
  }
}
