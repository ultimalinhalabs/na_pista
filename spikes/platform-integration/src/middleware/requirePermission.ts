import type { NextFunction, Request, Response } from "express";
import { roleHasPermission } from "../authorization/permissions.js";
import { ForbiddenError } from "../shared/errors.js";

/** Human path only — a service credential's authorization is its scopes (requireScope.ts), never a role. */
export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant || req.tenant.actorType !== "human" || !req.tenant.roleKey) {
      return next(new ForbiddenError("This operation requires a human membership"));
    }
    if (!roleHasPermission(req.tenant.roleKey, permission)) {
      return next(new ForbiddenError(`Missing permission: ${permission}`));
    }
    next();
  };
}
