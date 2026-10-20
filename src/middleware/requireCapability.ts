import type { NextFunction, Request, Response } from "express";
import { fetchEntitlements, interpretCapability, interpretModule, MODULE_NAMES, type ModuleName } from "../platform/entitlements.js";
import { EntitlementRequiredError } from "../shared/errors.js";

/**
 * ADR-022 (OD-14, F19): the Products/Categories module was gated on the
 * already-seeded `catalog.enabled` Platform entitlement, and every later module
 * reused it. Since the 2026-10-20 audit (UL migration 0031) each module has its
 * own key — see `MODULE_KEYS` in platform/entitlements.ts — and `catalog.enabled`
 * only covers products, categories and stock.
 */
export const CATALOG_CAPABILITY_KEY = "catalog.enabled";

export function requireCapability(key: string) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) throw new EntitlementRequiredError("No tenant context resolved");
      const resolved = await fetchEntitlements(req.tenant.organizationId, req.requestId);
      const decision = interpretCapability(resolved, key);
      if (!decision.enabled) {
        throw new EntitlementRequiredError(`Capability "${key}" is not enabled (${decision.reason})`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** The module's own entitlement (and its dependencies) must be enabled — a direct API call is refused like a menu click. */
export function requireModule(module: ModuleName) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) throw new EntitlementRequiredError("No tenant context resolved");
      const decision = interpretModule(await fetchEntitlements(req.tenant.organizationId, req.requestId), module);
      if (!decision.enabled) throw new EntitlementRequiredError(`Module "${module}" is not enabled (${decision.reason})`);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Organization-wide features (audit log, organization settings): any contracted module is enough. */
export function requireAnyModule() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.tenant) throw new EntitlementRequiredError("No tenant context resolved");
      const resolved = await fetchEntitlements(req.tenant.organizationId, req.requestId);
      if (!MODULE_NAMES.some((m) => interpretModule(resolved, m).enabled)) throw new EntitlementRequiredError("No Na Pista module is enabled for this organization");
      next();
    } catch (error) {
      next(error);
    }
  };
}
