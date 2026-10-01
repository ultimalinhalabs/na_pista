import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString, validateUuidParams } from "../../shared/params.js";
import { ForbiddenError } from "../../shared/errors.js";
import { roleHasPermission } from "../../authorization/permissions.js";
import { ok } from "../../shared/response.js";
import { parseBody, parseQuery } from "../../shared/validate.js";
import { createMovementSchema, listInventoryQuerySchema, listMovementsQuerySchema } from "./schemas.js";
import { createMovement, getBalanceOrThrow, listAllBalances, listAllMovements } from "./service.js";

export const inventoryRouter = Router();
validateUuidParams(inventoryRouter);

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

inventoryRouter.get(
  "/organizations/:organizationId/inventory",
  ...GATE,
  requireAuthorized("inventory.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = parseQuery(listInventoryQuerySchema, req.query);
      const items = await listAllBalances(req.tenant!, query);
      ok(res, items);
    } catch (error) {
      next(error);
    }
  },
);

inventoryRouter.get(
  "/organizations/:organizationId/inventory/:productId",
  ...GATE,
  requireAuthorized("inventory.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const balance = await getBalanceOrThrow(req.tenant!, paramString(req.params.productId)!);
      ok(res, balance);
    } catch (error) {
      next(error);
    }
  },
);

inventoryRouter.get(
  "/organizations/:organizationId/inventory/:productId/movements",
  ...GATE,
  requireAuthorized("inventory.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = parseQuery(listMovementsQuerySchema, req.query);
      const movements = await listAllMovements(req.tenant!, paramString(req.params.productId)!, query);
      ok(res, movements);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * F22 brief §19: RECEIPT is gated by `inventory.create` (it can bring a
 * new balance into existence); ADJUSTMENT_IN/ADJUSTMENT_OUT are gated by
 * `inventory.update`. Which permission applies depends on the request
 * BODY (`type`), not just the route — so the check runs inside the
 * handler, after validation, using the exact same primitives
 * `requireAuthorized` uses for every other route (never a second
 * authorization mechanism, F22 brief §0/§19).
 */
inventoryRouter.post(
  "/organizations/:organizationId/inventory/:productId/movements",
  ...GATE,
  async (req, res, next) => {
    try {
      const body = parseBody(createMovementSchema, req.body);
      const permission = body.type === "RECEIPT" ? "inventory.create" : "inventory.update";
      const scope = "catalog.write";

      if (req.tenant!.actorType === "human") {
        if (!req.tenant!.roleKey || !roleHasPermission(req.tenant!.roleKey, permission)) {
          throw new ForbiddenError(`Missing permission: ${permission}`);
        }
      } else if (req.tenant!.actorType === "service") {
        if (!req.tenant!.scopes?.includes(scope)) {
          throw new ForbiddenError(`Missing scope: ${scope}`);
        }
      } else {
        throw new ForbiddenError();
      }

      const result = await createMovement(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.productId)!, body);
      ok(res, result, 201);
    } catch (error) {
      next(error);
    }
  },
);
