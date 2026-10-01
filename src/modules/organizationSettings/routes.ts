import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { validateUuidParams } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { parseBody } from "../../shared/validate.js";
import { updateOrganizationSettingsSchema } from "./schemas.js";
import { getOrganizationSettingsOrNull, updateOrganizationSettings } from "./service.js";

/**
 * F26: `organization_settings` exists solely to support Scheduling today
 * (ADR-040) — gated on `scheduling.read`/`scheduling.update` rather than
 * a new `organization_settings.*` permission namespace invented for a
 * single-purpose settings surface (docs/f26-report.md §14). If a future
 * feature besides Scheduling needs Organization-level settings, that is
 * the trigger to introduce a dedicated permission, not now.
 */
export const organizationSettingsRouter = Router();
validateUuidParams(organizationSettingsRouter);

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

organizationSettingsRouter.get(
  "/organizations/:organizationId/settings",
  ...GATE,
  requireAuthorized("scheduling.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const settings = await getOrganizationSettingsOrNull(req.tenant!);
      ok(res, settings);
    } catch (error) {
      next(error);
    }
  },
);

organizationSettingsRouter.put(
  "/organizations/:organizationId/settings",
  ...GATE,
  requireAuthorized("scheduling.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(updateOrganizationSettingsSchema, req.body);
      const settings = await updateOrganizationSettings(req.tenant!, actorFromRequest(req), req.requestId, body.timezone);
      ok(res, settings);
    } catch (error) {
      next(error);
    }
  },
);
