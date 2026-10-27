import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { effectiveNaPistaRoleKey, hasNaPistaApplicationAccess, isOrganizationSuspended, membershipFor } from "../platform/membership.js";
import {
  ApplicationAccessRequiredError,
  ForbiddenError,
  OrganizationSuspendedError,
  UnauthorizedError,
} from "../shared/errors.js";
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
/**
 * D2-B — commercially authorized access is never optional in production: the variable can only relax
 * the check for local/test harnesses (NODE_ENV development/test), never for a real deployment.
 */
export function requiresApplicationAccess(nodeEnv: string = env.NODE_ENV, flag: string = env.NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS): boolean {
  return nodeEnv === "production" || flag === "true";
}

export function requireTenantContext(paramName = "organizationId") {
  return (req: Request, _res: Response, next: NextFunction) => {
    const organizationId = paramString(req.params[paramName]);
    if (!organizationId) return next(new ForbiddenError(`Missing :${paramName} route parameter`));

    if (req.service) {
      // Credentials audit 2026-10-23: a key is an organization's integration WITH one application (UL api_keys
      // semantics). A key issued for another application (e.g. QUALE_A_DICA, FOI) is never a Na Pista credential,
      // whatever its scopes are called. Read from the introspection Na Pista already does — no extra call.
      if (req.service.application !== "NA_PISTA") {
        return next(new ForbiddenError("This credential was issued for another application"));
      }
      if (req.service.organizationId !== organizationId) {
        return next(new ForbiddenError("This credential is not scoped to this organization"));
      }
      req.tenant = { organizationId, actorType: "service", scopes: req.service.scopes };
      return next();
    }

    if (req.auth && req.identity) {
      const membership = membershipFor(req.identity, organizationId);
      if (!membership) return next(new ForbiddenError("No active membership in this organization"));
      // Fase 6 — UL statuses, read from the Platform (never a local authority).
      if (isOrganizationSuspended(membership)) return next(new OrganizationSuspendedError());
      if (requiresApplicationAccess() && !hasNaPistaApplicationAccess(membership)) {
        return next(new ApplicationAccessRequiredError());
      }
      req.tenant = {
        organizationId,
        actorType: "human",
        roleKey: effectiveNaPistaRoleKey(membership),
        userId: req.auth.userId,
      };
      return next();
    }

    return next(new UnauthorizedError());
  };
}
