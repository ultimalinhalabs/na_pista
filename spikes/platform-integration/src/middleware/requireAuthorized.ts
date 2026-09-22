import type { NextFunction, Request, Response } from "express";
import { roleHasPermission } from "../authorization/permissions.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";

/**
 * A route reachable by both a human member (permission) and an
 * integration credential (scope) — the same duality ul-platform's own
 * `requireEntitlementAccess` establishes for entitlements, generalized
 * here to ordinary business operations. Two independent checks, never
 * one generic check bent to fit both (authorization.md §2/§3).
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
