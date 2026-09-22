import type { NextFunction, Request, Response } from "express";
import { membershipFor } from "../platform/membership.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { paramString } from "../shared/params.js";

/**
 * ADR-002/ADR-021: resolves `:organizationId` from the path into a
 * validated TenantContext. The path segment is never trusted by itself —
 * it only becomes `req.tenant` after either:
 *  - human: an ACTIVE membership for this user in this org (from the
 *    Platform's own GET /v1/me, never a locally-cached copy of it), or
 *  - service: the credential's OWN stored organizationId (from Platform
 *    introspection) matches the path exactly.
 * Anything else is 403 — never a silent fallback.
 */
export function requireTenantContext(paramName = "organizationId") {
  return (req: Request, _res: Response, next: NextFunction) => {
    const organizationId = paramString(req.params[paramName]);
    if (!organizationId) return next(new ForbiddenError(`Missing :${paramName} route parameter`));

    if (req.service) {
      if (req.service.organizationId !== organizationId) {
        return next(new ForbiddenError("This credential is not scoped to this organization"));
      }
      req.tenant = { organizationId, actorType: "service", scopes: req.service.scopes };
      return next();
    }

    if (req.auth && req.identity) {
      const membership = membershipFor(req.identity, organizationId);
      if (!membership) return next(new ForbiddenError("No active membership in this organization"));
      req.tenant = {
        organizationId,
        actorType: "human",
        roleKey: membership.roleKey,
        userId: req.auth.userId,
      };
      return next();
    }

    return next(new UnauthorizedError());
  };
}
