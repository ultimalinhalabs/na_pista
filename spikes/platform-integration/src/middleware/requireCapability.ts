import type { NextFunction, Request, Response } from "express";
import { fetchEntitlements, interpretCapability } from "../platform/entitlements.js";
import { EntitlementRequiredError } from "../shared/errors.js";

/**
 * OD-14 interim decision (see docs/decisions.md): the canonical key this
 * spike settles on is `products.enabled`, but the real seeded NA_PISTA
 * plans only have `catalog.enabled` today (DV-3/PG-4 — no HTTP path to
 * add a new plan_entitlements key; only a seed PR can). Rather than
 * mutate ul-platform's seed data to prove a point, this spike reuses the
 * existing `catalog.enabled` key as the interim products-capability
 * signal and records `products.enabled` as the target name for the real
 * seed migration — see docs/platform-changes-required.md.
 */
export const PRODUCTS_CAPABILITY_KEY = "catalog.enabled";

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
