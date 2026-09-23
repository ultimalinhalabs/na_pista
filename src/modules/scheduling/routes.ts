import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { availabilityQuerySchema, createExceptionSchema, replaceScheduleSchema } from "./schemas.js";
import {
  createExceptionOrThrow,
  getAvailabilityOrThrow,
  getScheduleOrThrow,
  listExceptionsOrThrow,
  removeExceptionOrThrow,
  replaceScheduleOrThrow,
} from "./service.js";

/**
 * ADR-039/F26 brief §23: "schedule" (persisted configuration, read/
 * write) is kept structurally separate from "availability" (computed,
 * read-only) — never merged into one giant endpoint. Route nesting
 * follows this codebase's own established convention
 * (`/organizations/:organizationId/professionals/:professionalId/...`),
 * not the F26A brief's illustrative names blindly.
 */
export const schedulingRouter = Router();

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

schedulingRouter.get(
  "/organizations/:organizationId/professionals/:professionalId/schedule",
  ...GATE,
  requireAuthorized("scheduling.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const rules = await getScheduleOrThrow(req.tenant!, paramString(req.params.professionalId)!);
      ok(res, rules);
    } catch (error) {
      next(error);
    }
  },
);

// Whole-set replacement (ADR-039 D10) — never a partial PATCH.
schedulingRouter.put(
  "/organizations/:organizationId/professionals/:professionalId/schedule",
  ...GATE,
  requireAuthorized("scheduling.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = replaceScheduleSchema.parse(req.body);
      const rules = await replaceScheduleOrThrow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.professionalId)!, body.rules);
      ok(res, rules);
    } catch (error) {
      next(error);
    }
  },
);

schedulingRouter.get(
  "/organizations/:organizationId/professionals/:professionalId/schedule/exceptions",
  ...GATE,
  requireAuthorized("scheduling.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const exceptions = await listExceptionsOrThrow(req.tenant!, paramString(req.params.professionalId)!);
      ok(res, exceptions);
    } catch (error) {
      next(error);
    }
  },
);

schedulingRouter.post(
  "/organizations/:organizationId/professionals/:professionalId/schedule/exceptions",
  ...GATE,
  requireAuthorized("scheduling.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = createExceptionSchema.parse(req.body);
      const exception = await createExceptionOrThrow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.professionalId)!, body);
      ok(res, exception, 201);
    } catch (error) {
      next(error);
    }
  },
);

schedulingRouter.delete(
  "/organizations/:organizationId/professionals/:professionalId/schedule/exceptions/:exceptionId",
  ...GATE,
  requireAuthorized("scheduling.update", "catalog.write"),
  async (req, res, next) => {
    try {
      await removeExceptionOrThrow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.professionalId)!, paramString(req.params.exceptionId)!);
      ok(res, { removed: true });
    } catch (error) {
      next(error);
    }
  },
);

schedulingRouter.get(
  "/organizations/:organizationId/professionals/:professionalId/availability",
  ...GATE,
  requireAuthorized("scheduling.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = availabilityQuerySchema.parse(req.query);
      const availability = await getAvailabilityOrThrow(req.tenant!, paramString(req.params.professionalId)!, query);
      ok(res, availability);
    } catch (error) {
      next(error);
    }
  },
);
