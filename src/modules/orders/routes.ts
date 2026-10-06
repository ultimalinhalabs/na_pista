import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString, validateUuidParams } from "../../shared/params.js";
import { ok, okPage } from "../../shared/response.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import { addOrderItemSchema, createOrderSchema, listOrdersQuerySchema, updateOrderItemSchema, updateOrderSchema } from "./schemas.js";
import {
  addOrderItem,
  cancelOrder,
  completeOrder,
  confirmOrder,
  createOrder,
  getOrderOrThrow,
  listOrdersPage,
  removeOrderItemOrThrow,
  updateOrderCustomerOrThrow,
  updateOrderItemQuantityOrThrow,
} from "./service.js";

export const ordersRouter = Router();
validateUuidParams(ordersRouter);

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

ordersRouter.post(
  "/organizations/:organizationId/orders",
  ...GATE,
  requireAuthorized("orders.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(createOrderSchema, req.body);
      const order = await createOrder(req.tenant!, actorFromRequest(req), req.requestId, body);
      ok(res, order, 201);
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.get(
  "/organizations/:organizationId/orders",
  ...GATE,
  requireAuthorized("orders.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = parseQuery(listOrdersQuerySchema, req.query);
      okPage(res, await listOrdersPage(req.tenant!, query));
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.get(
  "/organizations/:organizationId/orders/:orderId",
  ...GATE,
  requireAuthorized("orders.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const order = await getOrderOrThrow(req.tenant!, paramString(req.params.orderId)!);
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);

/** DRAFT-only (enforced in the service layer) — currently only `customerId` is editable this way (F23 brief §16/§23). */
ordersRouter.patch(
  "/organizations/:organizationId/orders/:orderId",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(updateOrderSchema, req.body);
      const order = await updateOrderCustomerOrThrow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.orderId)!, body.customerId ?? null);
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.post(
  "/organizations/:organizationId/orders/:orderId/items",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(addOrderItemSchema, req.body);
      const order = await addOrderItem(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.orderId)!, body);
      ok(res, order, 201);
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.patch(
  "/organizations/:organizationId/orders/:orderId/items/:itemId",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(updateOrderItemSchema, req.body);
      const order = await updateOrderItemQuantityOrThrow(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.orderId)!,
        paramString(req.params.itemId)!,
        body.quantity,
      );
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.delete(
  "/organizations/:organizationId/orders/:orderId/items/:itemId",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const order = await removeOrderItemOrThrow(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.orderId)!, paramString(req.params.itemId)!);
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);

// Explicit lifecycle endpoints (F23 brief §24) — never a generic DELETE
// on /orders/:orderId, since the lifecycle model does not support a
// physical delete and "cancel" is the correct, explicit verb.
ordersRouter.post(
  "/organizations/:organizationId/orders/:orderId/confirm",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const order = await confirmOrder(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.orderId)!);
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.post(
  "/organizations/:organizationId/orders/:orderId/cancel",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const order = await cancelOrder(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.orderId)!);
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);

ordersRouter.post(
  "/organizations/:organizationId/orders/:orderId/complete",
  ...GATE,
  requireAuthorized("orders.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const order = await completeOrder(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.orderId)!);
      ok(res, order);
    } catch (error) {
      next(error);
    }
  },
);
