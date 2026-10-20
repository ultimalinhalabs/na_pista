import { Router } from "express";
import { requireHumanPermission } from "../../middleware/requireAuthorized.js";
import { enabledModules, fetchEntitlements } from "../../platform/entitlements.js";
import { validateUuidParams } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";

export const organizationModulesRouter = Router();
validateUuidParams(organizationModulesRouter);

/**
 * Audit 2026-10-20 — which Na Pista modules the organization's plan enables, so the Console shows only those.
 * Display only: every module route still enforces its own entitlement (a direct API call is refused the same
 * way). Not behind a module gate (it is how the Console learns there is none); UL unavailable → 503 as usual.
 */
organizationModulesRouter.get(
  "/organizations/:organizationId/modules",
  requireTenantContext(),
  requireHumanPermission("modules.read"),
  async (req, res, next) => {
    try {
      ok(res, enabledModules(await fetchEntitlements(req.tenant!.organizationId, req.requestId)));
    } catch (error) {
      next(error);
    }
  },
);
