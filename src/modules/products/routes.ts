import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { createProductSchema, listProductsQuerySchema, updateProductSchema } from "./schemas.js";
import { archiveProduct, createProduct, getProductOrThrow, listAllProducts, updateProductOrThrow } from "./service.js";

export const productsRouter = Router();

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

productsRouter.post(
  "/organizations/:organizationId/products",
  ...GATE,
  requireAuthorized("products.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = createProductSchema.parse(req.body);
      const product = await createProduct(req.tenant!, actorFromRequest(req), req.requestId, body);
      ok(res, product, 201);
    } catch (error) {
      next(error);
    }
  },
);

productsRouter.get(
  "/organizations/:organizationId/products",
  ...GATE,
  requireAuthorized("products.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = listProductsQuerySchema.parse(req.query);
      const items = await listAllProducts(req.tenant!, query);
      ok(res, items);
    } catch (error) {
      next(error);
    }
  },
);

productsRouter.get(
  "/organizations/:organizationId/products/:productId",
  ...GATE,
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

productsRouter.patch(
  "/organizations/:organizationId/products/:productId",
  ...GATE,
  requireAuthorized("products.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = updateProductSchema.parse(req.body);
      const product = await updateProductOrThrow(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.productId)!,
        body,
      );
      ok(res, product);
    } catch (error) {
      next(error);
    }
  },
);

// DELETE = archive, never a physical delete (ADR-020).
productsRouter.delete(
  "/organizations/:organizationId/products/:productId",
  ...GATE,
  requireAuthorized("products.delete", "catalog.write"),
  async (req, res, next) => {
    try {
      const product = await archiveProduct(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.productId)!);
      ok(res, product);
    } catch (error) {
      next(error);
    }
  },
);
