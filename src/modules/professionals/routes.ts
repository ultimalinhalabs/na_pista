import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { createProfessionalSchema, listProfessionalsQuerySchema, updateProfessionalSchema } from "./schemas.js";
import {
  associateService,
  createProfessional,
  getProfessionalOrThrow,
  listAllProfessionals,
  listServicesForProfessionalOrThrow,
  removeAssociation,
  updateProfessionalOrThrow,
} from "./service.js";

export const professionalsRouter = Router();

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

professionalsRouter.post(
  "/organizations/:organizationId/professionals",
  ...GATE,
  requireAuthorized("professionals.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = createProfessionalSchema.parse(req.body);
      const professional = await createProfessional(req.tenant!, actorFromRequest(req), req.requestId, body);
      ok(res, professional, 201);
    } catch (error) {
      next(error);
    }
  },
);

professionalsRouter.get(
  "/organizations/:organizationId/professionals",
  ...GATE,
  requireAuthorized("professionals.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = listProfessionalsQuerySchema.parse(req.query);
      const items = await listAllProfessionals(req.tenant!, query);
      ok(res, items);
    } catch (error) {
      next(error);
    }
  },
);

professionalsRouter.get(
  "/organizations/:organizationId/professionals/:professionalId",
  ...GATE,
  requireAuthorized("professionals.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const professional = await getProfessionalOrThrow(req.tenant!, paramString(req.params.professionalId)!);
      ok(res, professional);
    } catch (error) {
      next(error);
    }
  },
);

// PATCH handles every mutation, including lifecycle (status: ACTIVE|ARCHIVED)
// — no DELETE, no dedicated /archive or /reactivate endpoints (ADR-036 §19).
professionalsRouter.patch(
  "/organizations/:organizationId/professionals/:professionalId",
  ...GATE,
  requireAuthorized("professionals.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = updateProfessionalSchema.parse(req.body);
      const professional = await updateProfessionalOrThrow(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.professionalId)!,
        body,
      );
      ok(res, professional);
    } catch (error) {
      next(error);
    }
  },
);

// Association sub-resource (ADR-037) — never a FK on Professional or
// Service directly. professionals.update also gates association
// management (F25A §8: no separate professional_services.manage tier).
professionalsRouter.get(
  "/organizations/:organizationId/professionals/:professionalId/services",
  ...GATE,
  requireAuthorized("professionals.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const items = await listServicesForProfessionalOrThrow(req.tenant!, paramString(req.params.professionalId)!);
      ok(res, items);
    } catch (error) {
      next(error);
    }
  },
);

professionalsRouter.post(
  "/organizations/:organizationId/professionals/:professionalId/services/:serviceId",
  ...GATE,
  requireAuthorized("professionals.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const association = await associateService(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.professionalId)!,
        paramString(req.params.serviceId)!,
      );
      ok(res, association, 201);
    } catch (error) {
      next(error);
    }
  },
);

professionalsRouter.delete(
  "/organizations/:organizationId/professionals/:professionalId/services/:serviceId",
  ...GATE,
  requireAuthorized("professionals.update", "catalog.write"),
  async (req, res, next) => {
    try {
      await removeAssociation(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.professionalId)!, paramString(req.params.serviceId)!);
      ok(res, { removed: true });
    } catch (error) {
      next(error);
    }
  },
);
