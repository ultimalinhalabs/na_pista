import type { NextFunction, Request, Response } from "express";
import { roleHasPermission } from "../authorization/permissions.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";

/**
 * A route reachable by both a human member (permission) and an
 * integration credential (scope) — two independent checks, never one
 * generic check bent to fit both.
 */
export function requireAuthorized(permission: string, scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) return next(new UnauthorizedError());

    if (req.tenant.actorType === "human") {
      if (!req.tenant.roleKey || !roleHasPermission(req.tenant.roleKey, permission)) {
        return next(new ForbiddenError(`Missing permission: ${permission}`));
      }
      return next();
    }

    if (req.tenant.actorType === "service") {
      if (!req.tenant.scopes?.includes(scope)) {
        return next(new ForbiddenError(`Missing scope: ${scope}`));
      }
      return next();
    }

    next(new UnauthorizedError());
  };
}

/**
 * F30 (ADR-055/056): a route only humans may call — integration/governance
 * metadata for which the Platform defines no service scope. Same primitives
 * as `requireAuthorized`; a service credential is refused explicitly.
 */
export function requireHumanPermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) return next(new UnauthorizedError());
    if (req.tenant.actorType === "service") {
      return next(new ForbiddenError("This operation is not available to service credentials"));
    }
    if (req.tenant.actorType === "human") {
      if (!req.tenant.roleKey || !roleHasPermission(req.tenant.roleKey, permission)) {
        return next(new ForbiddenError(`Missing permission: ${permission}`));
      }
      return next();
    }
    next(new UnauthorizedError());
  };
}
