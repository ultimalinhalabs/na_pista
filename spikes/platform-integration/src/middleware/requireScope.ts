import type { NextFunction, Request, Response } from "express";
import { ForbiddenError } from "../shared/errors.js";

/** Service path only — mirrors ul-platform's requireServiceScope.ts. A human session can never satisfy this. */
export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant || req.tenant.actorType !== "service" || !req.tenant.scopes) {
      return next(new ForbiddenError("This operation requires a service credential"));
    }
    if (!req.tenant.scopes.includes(scope)) {
      return next(new ForbiddenError(`Missing scope: ${scope}`));
    }
    next();
  };
}
