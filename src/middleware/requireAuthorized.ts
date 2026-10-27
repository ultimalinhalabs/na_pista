import type { NextFunction, Request, Response } from "express";
import { roleHasPermission } from "../authorization/permissions.js";
import { LEGACY_SCOPE } from "../authorization/serviceScopes.js";
import { env } from "../config/env.js";
import { ForbiddenError, UnauthorizedError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

/** One log line per key and scope per process — enough to find who still relies on a legacy scope, never a flood. */
const legacyUseLogged = new Set<string>();

/** The service credential holds `scope`, or (transition, NA_PISTA keys only — see tenantContext) its legacy scope. */
export function serviceHasScope(
  service: { apiKeyId: string; scopes?: string[] },
  scope: string,
  mode: "accept" | "refuse" = env.NA_PISTA_LEGACY_CATALOG_SCOPES,
): boolean {
  if (service.scopes?.includes(scope)) return true;
  const legacy = LEGACY_SCOPE[scope];
  if (!legacy || mode !== "accept" || !service.scopes?.includes(legacy)) return false;
  const key = `${service.apiKeyId}|${scope}`;
  if (!legacyUseLogged.has(key)) {
    legacyUseLogged.add(key);
    logger.warn("service.legacy_scope_used", { apiKeyId: service.apiKeyId, requiredScope: scope, acceptedScope: legacy });
  }
  return true;
}

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
      if (!req.service || !serviceHasScope({ apiKeyId: req.service.apiKeyId, scopes: req.tenant.scopes }, scope)) {
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
