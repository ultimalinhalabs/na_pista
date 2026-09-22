import { Router } from "express";
import { CATALOG_CAPABILITY_KEY, requireCapability } from "../../middleware/requireCapability.js";
import { requireAuthorized } from "../../middleware/requireAuthorized.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { actorFromRequest } from "../../tenancy/actor.js";
import { paramString } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { createCategorySchema, listCategoriesQuerySchema, updateCategorySchema } from "./schemas.js";
import { archiveCategory, createCategory, getCategoryOrThrow, listAllCategories, updateCategoryOrThrow } from "./service.js";

export const categoriesRouter = Router();

const GATE = [requireTenantContext(), requireCapability(CATALOG_CAPABILITY_KEY)] as const;

categoriesRouter.post(
  "/organizations/:organizationId/categories",
  ...GATE,
  requireAuthorized("categories.create", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = createCategorySchema.parse(req.body);
      const category = await createCategory(req.tenant!, actorFromRequest(req), req.requestId, body);
      ok(res, category, 201);
    } catch (error) {
      next(error);
    }
  },
);

categoriesRouter.get(
  "/organizations/:organizationId/categories",
  ...GATE,
  requireAuthorized("categories.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const query = listCategoriesQuerySchema.parse(req.query);
      const items = await listAllCategories(req.tenant!, query);
      ok(res, items);
    } catch (error) {
      next(error);
    }
  },
);

categoriesRouter.get(
  "/organizations/:organizationId/categories/:categoryId",
  ...GATE,
  requireAuthorized("categories.read", "catalog.read"),
  async (req, res, next) => {
    try {
      const category = await getCategoryOrThrow(req.tenant!, paramString(req.params.categoryId)!);
      ok(res, category);
    } catch (error) {
      next(error);
    }
  },
);

categoriesRouter.patch(
  "/organizations/:organizationId/categories/:categoryId",
  ...GATE,
  requireAuthorized("categories.update", "catalog.write"),
  async (req, res, next) => {
    try {
      const body = updateCategorySchema.parse(req.body);
      const category = await updateCategoryOrThrow(
        req.tenant!,
        actorFromRequest(req),
        req.requestId,
        paramString(req.params.categoryId)!,
        body,
      );
      ok(res, category);
    } catch (error) {
      next(error);
    }
  },
);

// DELETE = archive, never a physical delete (ADR-020).
categoriesRouter.delete(
  "/organizations/:organizationId/categories/:categoryId",
  ...GATE,
  requireAuthorized("categories.delete", "catalog.write"),
  async (req, res, next) => {
    try {
      const category = await archiveCategory(req.tenant!, actorFromRequest(req), req.requestId, paramString(req.params.categoryId)!);
      ok(res, category);
    } catch (error) {
      next(error);
    }
  },
);
