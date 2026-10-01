import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireHumanPermission } from "../../middleware/requireAuthorized.js";
import { validateUuidParams } from "../../shared/params.js";
import { okPage } from "../../shared/response.js";
import { parseQuery } from "../../shared/validate.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { listAuditEventsPage } from "./read.js";
import { listAuditEventsQuerySchema } from "./schemas.js";

export const auditRouter = Router();
validateUuidParams(auditRouter);

/** ADR-055: read-only, tenant-scoped business audit trail. OWNER/ADMIN (`audit.read`), humans only. */
auditRouter.get(
  "/organizations/:organizationId/audit-events",
  requireTenantContext(),
  requireCapability(CATALOG_CAPABILITY_KEY),
  requireHumanPermission("audit.read"),
  async (req, res, next) => {
    try {
      const query = parseQuery(listAuditEventsQuerySchema, req.query);
      okPage(res, await listAuditEventsPage(req.tenant!, query));
    } catch (error) {
      next(error);
    }
  },
);
