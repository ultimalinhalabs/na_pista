import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./shared/logger.js";

const app = buildApp();
app.listen(env.PORT, () => {
  logger.info("server.started", { port: env.PORT });
});
