import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString, validateUuidParams } from "../../shared/params.js";
import { ok, okPage } from "../../shared/response.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import { createServiceSchema, listServicesQuerySchema, updateServiceSchema } from "./schemas.js";
import { createService, getServiceOrThrow, listServicesPage, updateServiceOrThrow } from "./service.js";

export const servicesRouter = Router();
validateUuidParams(servicesRouter);

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

servicesRouter.post(
  "/organizations/:organizationId/services",
  ...GATE,
  requireAuthorized("services.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(createServiceSchema, req.body);
      const service = await createService(req.tenant!, actorFromRequest(req), req.requestId, body);
      ok(res, service, 201);
    } catch (error) {
      next(error);
    }
  },
);

servicesRouter.get(
  "/organizations/:organizationId/services",
  ...GATE,
  requireAuthorized("services.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = parseQuery(listServicesQuerySchema, req.query);
      okPage(res, await listServicesPage(req.tenant!, query));
    } catch (error) {
      next(error);
    }
  },
);

servicesRouter.get(
  "/organizations/:organizationId/services/:serviceId",
  ...GATE,
  requireAuthorized("services.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const service = await getServiceOrThrow(req.tenant!, paramString(req.params.serviceId)!);
      ok(res, service);
    } catch (error) {
      next(error);
    }
  },
);

// PATCH handles every mutation, including lifecycle (status: ACTIVE|ARCHIVED)
// — no DELETE, no dedicated /archive or /reactivate endpoints (F24A/ADR-033 §19).
servicesRouter.patch(
  "/organizations/:organizationId/services/:serviceId",
  ...GATE,
  requireAuthorized("services.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(updateServiceSchema, req.body);
      const service = await updateServiceOrThrow(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.serviceId)!,
        body,
      );
      ok(res, service);
    } catch (error) {
      next(error);
    }
  },
);
