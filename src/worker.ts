import { sql } from "drizzle-orm";
import { env } from "./config/env.js";
import { db, queryClient } from "./db/index.js";
import { startProvisioningReconciler, stopProvisioningReconciler } from "./modules/platformCredentials/reconciler.js";
import { logger } from "./shared/logger.js";

/**
 * OPTIONAL persistent worker (`npm run start:worker`; local harnesses or a self-hosted deployment): runs ONLY the D2-B
 * provisioning reconciler on an interval. Production does NOT run it (owner decision 2026-10-18 — no service billing
 * 24/7 while unused): provisioning there is on demand (resolver.ts) plus a daily Vercel Cron (vercel.json).
 *
 * Fails fast (exit 1, so the platform's restart policy and alerts see it) when the database is unreachable or no
 * PROVISIONER credential is configured: a worker that "runs" without doing anything would hide the problem.
 */

try {
  await db.execute(sql`select 1`);
} catch (error) {
  logger.error("worker.startup.db_error", { error: error instanceof Error ? error.name : "unknown" });
  await queryClient.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}

if (!startProvisioningReconciler()) {
  logger.error("worker.startup.no_provisioning_credential", { hint: "set NA_PISTA_PROVISIONING_CREDENTIAL" });
  await queryClient.end({ timeout: 5 }).catch(() => undefined);
  process.exit(1);
}
logger.info("worker.started", { intervalMs: env.NA_PISTA_RECONCILE_INTERVAL_MS });

// The reconciler's own timer is unref()'d (so it never holds the HTTP server open in development); this referenced
// heartbeat keeps the worker process alive and leaves a periodic trace in the logs.
const heartbeat = setInterval(() => logger.info("worker.heartbeat", {}), 10 * 60_000);

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("worker.shutdown", { signal });
  clearInterval(heartbeat);
  stopProvisioningReconciler();
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  void queryClient
    .end({ timeout: 5 })
    .catch(() => undefined)
    .finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
