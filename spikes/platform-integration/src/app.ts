import express from "express";
import { authenticate } from "./middleware/authenticate.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { productsRouter } from "./modules/products/routes.js";
import { requestId } from "./shared/requestId.js";
import { ok } from "./shared/response.js";

export function buildApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use(requestId);

  app.get("/v1/health", (_req, res) => ok(res, { status: "ok" }));

  app.use("/v1", authenticate, productsRouter);

  app.use(errorHandler);
  return app;
}
