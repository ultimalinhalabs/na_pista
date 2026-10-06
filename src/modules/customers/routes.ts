import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString, validateUuidParams } from "../../shared/params.js";
import { ok, okPage } from "../../shared/response.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import { createCustomerSchema, listCustomersQuerySchema, updateCustomerSchema } from "./schemas.js";
import { archiveCustomer, createCustomer, getCustomerOrThrow, listCustomersPage, updateCustomerOrThrow } from "./service.js";

export const customersRouter = Router();
validateUuidParams(customersRouter);

/**
 * Gated by `catalog.enabled` (ADR-022's key, reused — see
 * na-pista/docs/f21-report.md "Entitlement" for why no new Platform
 * entitlement was invented for Customers).
 */
const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

customersRouter.post(
  "/organizations/:organizationId/customers",
  ...GATE,
  requireAuthorized("customers.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(createCustomerSchema, req.body);
      const customer = await createCustomer(req.tenant!, actorFromRequest(req), req.requestId, body);
      ok(res, customer, 201);
    } catch (error) {
      next(error);
    }
  },
);

customersRouter.get(
  "/organizations/:organizationId/customers",
  ...GATE,
  requireAuthorized("customers.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = parseQuery(listCustomersQuerySchema, req.query);
      okPage(res, await listCustomersPage(req.tenant!, query));
    } catch (error) {
      next(error);
    }
  },
);

customersRouter.get(
  "/organizations/:organizationId/customers/:customerId",
  ...GATE,
  requireAuthorized("customers.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const customer = await getCustomerOrThrow(req.tenant!, paramString(req.params.customerId)!);
      ok(res, customer);
    } catch (error) {
      next(error);
    }
  },
);

customersRouter.patch(
  "/organizations/:organizationId/customers/:customerId",
  ...GATE,
  requireAuthorized("customers.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = parseBody(updateCustomerSchema, req.body);
      const customer = await updateCustomerOrThrow(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.customerId)!,
        body,
      );
      ok(res, customer);
    } catch (error) {
      next(error);
    }
  },
);

// DELETE = archive, never a physical delete (ADR-026).
customersRouter.delete(
  "/organizations/:organizationId/customers/:customerId",
  ...GATE,
  requireAuthorized("customers.delete", "catalog.write"),
  async (req, res, next) => {
    try {
      const customer = await archiveCustomer(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.customerId)!);
      ok(res, customer);
    } catch (error) {
      next(error);
    }
  },
);
