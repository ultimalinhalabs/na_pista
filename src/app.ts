import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { authenticate } from "./middleware/authenticate.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { categoriesRouter } from "./modules/categories/routes.js";
import { customersRouter } from "./modules/customers/routes.js";
import { inventoryRouter } from "./modules/inventory/routes.js";
import { ordersRouter } from "./modules/orders/routes.js";
import { productsRouter } from "./modules/products/routes.js";
import { requestId } from "./shared/requestId.js";
import { ok } from "./shared/response.js";

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: env.NA_PISTA_ALLOWED_ORIGINS,
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(requestId);

  app.get("/v1/health", (_req, res) => ok(res, { status: "ok" }));

  app.use("/v1", authenticate, categoriesRouter, productsRouter, customersRouter, inventoryRouter, ordersRouter);

  app.use(errorHandler);
  return app;
}
