import { Router } from "express";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { PRODUCTS_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { ValidationError } from "../../shared/errors.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { createProduct, getProductOrThrow, listAllProducts } from "./service.js";

/**
 * F19 §24: the minimum resource needed to demonstrate the pipeline end to
 * end — id/organizationId/name/status, create + read only. Not the real
 * Product module (see na-pista/docs/modules.md for that).
 */
export const productsRouter = Router();

productsRouter.post(
  "/organizations/:organizationId/products",
  requireTenantContext(),
  requireCapability(PRODUCTS_CAPABILITY_KEY),
  requireAuthorized("products.write", "catalog.write"),
  async (req, res, next) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
      if (!name) throw new ValidationError('"name" is required');
      const product = await createProduct(req.tenant!, req.requestId, { name });
      ok(res, product, 201);
    } catch (error) {
      next(error);
    }
  },
);

productsRouter.get(
  "/organizations/:organizationId/products",
  requireTenantContext(),
  requireCapability(PRODUCTS_CAPABILITY_KEY),
  requireAuthorized("products.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const items = await listAllProducts(req.tenant!);
      ok(res, items);
    } catch (error) {
      next(error);
    }
  },
);

productsRouter.get(
  "/organizations/:organizationId/products/:productId",
  requireTenantContext(),
  requireCapability(PRODUCTS_CAPABILITY_KEY),
  requireAuthorized("products.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const product = await getProductOrThrow(req.tenant!, paramString(req.params.productId)!);
      ok(res, product);
    } catch (error) {
      next(error);
    }
  },
);
