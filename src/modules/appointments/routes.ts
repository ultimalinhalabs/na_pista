import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { bookableSlotsQuerySchema, cancelAppointmentSchema, createAppointmentSchema, listAppointmentsQuerySchema, noShowAppointmentSchema, updateAppointmentSchema } from "./schemas.js";
import {
  cancelAppointment,
  completeAppointment,
  createAppointment,
  getAppointmentOrThrow,
  getBookableSlotsOrThrow,
  listAppointmentsOrThrow,
  markAppointmentNoShow,
  updateAppointmentOrThrow,
} from "./service.js";

/**
 * F27 (F27A §40): organization-scoped, gated by tenant context +
 * `catalog.enabled` (ADR-022 reuse) + `appointments.*` permission /
 * `catalog.*` scope. Lifecycle transitions are dedicated endpoints
 * (`/cancel`, `/complete`, `/no-show`) — the Orders precedent — never a writable
 * `status` field. No DELETE: appointments are never deleted.
 */
export const appointmentsRouter = Router();

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

appointmentsRouter.post("/organizations/:organizationId/appointments", ...GATE, requireAuthorized("appointments.create", "catalog.write"), async (req, res, next) => {
  try {
    const body = createAppointmentSchema.parse(req.body);
    const appointment = await createAppointment(req.tenant!, actorFromRequest(req), req.requestId, body);
    ok(res, appointment, 201);
  } catch (error) {
    next(error);
  }
});

appointmentsRouter.get("/organizations/:organizationId/appointments", ...GATE, requireAuthorized("appointments.read", "catalog.read"), async (req, res, next) => {
  try {
    const query = listAppointmentsQuerySchema.parse(req.query);
    ok(res, await listAppointmentsOrThrow(req.tenant!, query));
  } catch (error) {
    next(error);
  }
});

appointmentsRouter.get(
  "/organizations/:organizationId/appointments/:appointmentId",
  ...GATE,
  requireAuthorized("appointments.read", "catalog.read"),
  async (req, res, next) => {
    try {
      ok(res, await getAppointmentOrThrow(req.tenant!, paramString(req.params.appointmentId)!));
    } catch (error) {
      next(error);
    }
  },
);

appointmentsRouter.patch(
  "/organizations/:organizationId/appointments/:appointmentId",
  ...GATE,
  requireAuthorized("appointments.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = updateAppointmentSchema.parse(req.body);
      ok(res, await updateAppointmentOrThrow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.appointmentId)!, body));
    } catch (error) {
      next(error);
    }
  },
);

appointmentsRouter.post(
  "/organizations/:organizationId/appointments/:appointmentId/cancel",
  ...GATE,
  requireAuthorized("appointments.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = cancelAppointmentSchema.parse(req.body ?? {});
      ok(res, await cancelAppointment(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.appointmentId)!, body));
    } catch (error) {
      next(error);
    }
  },
);

appointmentsRouter.post(
  "/organizations/:organizationId/appointments/:appointmentId/complete",
  ...GATE,
  requireAuthorized("appointments.update", "catalog.write"),
  async (req, res, next) => {
    try {
      ok(res, await completeAppointment(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.appointmentId)!));
    } catch (error) {
      next(error);
    }
  },
);

// F28B (ADR-048): SCHEDULED -> NO_SHOW, same gate as cancel/complete.
appointmentsRouter.post(
  "/organizations/:organizationId/appointments/:appointmentId/no-show",
  ...GATE,
  requireAuthorized("appointments.update", "catalog.write"),
  async (req, res, next) => {
    try {
      noShowAppointmentSchema.parse(req.body ?? {});
      ok(res, await markAppointmentNoShow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.appointmentId)!));
    } catch (error) {
      next(error);
    }
  },
);

// ADR-040: bookable (working − booked) availability is Appointment's, not Scheduling's — lives here, next to F26's own /availability path shape.
appointmentsRouter.get(
  "/organizations/:organizationId/professionals/:professionalId/bookable-slots",
  ...GATE,
  requireAuthorized("appointments.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = bookableSlotsQuerySchema.parse(req.query);
      ok(res, await getBookableSlotsOrThrow(req.tenant!, paramString(req.params.professionalId)!, query));
    } catch (error) {
      next(error);
    }
  },
);
