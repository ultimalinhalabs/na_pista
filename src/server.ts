import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { startProvisioningReconciler } from "./modules/platformCredentials/reconciler.js";
import { logger } from "./shared/logger.js";

const app = buildApp();
app.listen(env.PORT, () => {
  logger.info("server.started", { port: env.PORT });
  // D2-B — pulls managed Platform credentials when a provisioner credential is configured.
  if (startProvisioningReconciler()) logger.info("platform_credential.reconciler_started", { intervalMs: env.NA_PISTA_RECONCILE_INTERVAL_MS });
});
