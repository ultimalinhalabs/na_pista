import type { NextFunction, Request, Response } from "express";
import { fetchEntitlements, interpretCapability } from "../platform/entitlements.js";
import { EntitlementRequiredError } from "../shared/errors.js";

/**
 * ADR-022 (OD-14, F19): the Products/Categories module is gated on the
 * already-seeded `catalog.enabled` Platform entitlement — no ul-platform
 * seed data was changed to build this module. The target canonical name
 * (`products.enabled`) is deferred Platform work (PC-4).
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
