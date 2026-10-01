import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { openApiDocument } from "./contract/openapi.js";
import { authenticate } from "./middleware/authenticate.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { appointmentsRouter } from "./modules/appointments/routes.js";
import { auditRouter } from "./modules/audit/routes.js";
import { categoriesRouter } from "./modules/categories/routes.js";
import { customersRouter } from "./modules/customers/routes.js";
import { inventoryRouter } from "./modules/inventory/routes.js";
import { ordersRouter } from "./modules/orders/routes.js";
import { organizationSettingsRouter } from "./modules/organizationSettings/routes.js";
import { platformCredentialsRouter } from "./modules/platformCredentials/routes.js";
import { productsRouter } from "./modules/products/routes.js";
import { professionalsRouter } from "./modules/professionals/routes.js";
import { schedulingRouter } from "./modules/scheduling/routes.js";
import { servicesRouter } from "./modules/services/routes.js";
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
  // ADR-053: request id first, so every response — including body-parse failures — carries X-Request-ID.
  app.use(requestId);
  app.use(express.json());

  app.get("/v1/health", (_req, res) => ok(res, { status: "ok" }));
  // ADR-054: the public contract — unauthenticated, contains no secret or internal detail.
  app.get("/v1/openapi.json", (_req, res) => {
    res.json(openApiDocument());
  });

  app.use(
    "/v1",
    authenticate,
    categoriesRouter,
    productsRouter,
    customersRouter,
    inventoryRouter,
    ordersRouter,
    servicesRouter,
    professionalsRouter,
    organizationSettingsRouter,
    schedulingRouter,
    appointmentsRouter,
    auditRouter,
    platformCredentialsRouter,
    // Authenticated but no route matched (anonymous callers already got 401: route existence is not disclosed).
    notFoundHandler,
  );

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
