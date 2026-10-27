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
export function requireAuthorized(permission: string, scope: string | readonly string[]) {
  const accepted = typeof scope === "string" ? [scope] : scope;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.tenant) return next(new UnauthorizedError());

    if (req.tenant.actorType === "human") {
      if (!req.tenant.roleKey || !roleHasPermission(req.tenant.roleKey, permission)) {
        return next(new ForbiddenError(`Missing permission: ${permission}`));
      }
      return next();
    }

    if (req.tenant.actorType === "service") {
      const service = req.service;
      if (!service || !accepted.some((s) => serviceHasScope({ apiKeyId: service.apiKeyId, scopes: req.tenant!.scopes }, s))) {
        return next(new ForbiddenError(`Missing scope: ${accepted.join(" or ")}`));
      }
      return next();
    }

    next(new UnauthorizedError());
  };
}

/**
 * Interface credential: a read a service key may make in full with `fullScope`, or — holding only `ownScope` — on the
 * resources it created itself. Sets `res.locals.ownResourcesOnly` for the handler, which must then check ownership
 * (and answer 404 for anything else, exactly like a resource of another organization). Humans: `permission`.
 */
export function requireReadOrOwn(permission: string, fullScope: string, ownScope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.tenant) return next(new UnauthorizedError());
    if (req.tenant.actorType === "human") {
      if (!req.tenant.roleKey || !roleHasPermission(req.tenant.roleKey, permission)) return next(new ForbiddenError(`Missing permission: ${permission}`));
      return next();
    }
    const service = req.service;
    if (req.tenant.actorType === "service" && service) {
      const scopes = { apiKeyId: service.apiKeyId, scopes: req.tenant.scopes };
      if (serviceHasScope(scopes, fullScope)) return next();
      if (serviceHasScope(scopes, ownScope)) {
        res.locals.ownResourcesOnly = true;
        return next();
      }
      return next(new ForbiddenError(`Missing scope: ${fullScope} or ${ownScope}`));
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
