import type { Request, Response } from "express";
import { queryClient } from "../db/index.js";
import { logger } from "../shared/logger.js";

/**
 * Runtime readiness. `/v1/health` = the process is alive; `/v1/health/ready` = it can serve traffic.
 *
 * The only dependency every request needs is Na Pista's own database, so readiness = a read-only
 * `select 1` answered within a short timeout. Deliberately NOT checked:
 *  - UL Platform: an outage already fails each dependent request closed (503); taking every instance
 *    out of rotation for it would only turn a partial outage into a total one;
 *  - the D2-B provisioner credential / reconciler: optional — the runtime serves without it.
 * The response never carries connection details, error text, keys or identifiers.
 */
export type ReadinessProbe = () => Promise<void>;

const databaseProbe: ReadinessProbe = async () => {
  await queryClient`select 1`;
};

export function readinessHandler(probe: ReadinessProbe = databaseProbe, timeoutMs = 2_000) {
  return async (req: Request, res: Response) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        probe(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        }),
      ]);
      res.status(200).json({ data: { status: "ready" } });
    } catch (error) {
      // Reason class only — driver errors can carry connection details and are never logged or returned.
      logger.warn("health.not_ready", { requestId: req.requestId, reason: error instanceof Error && error.message === "timeout" ? "DATABASE_TIMEOUT" : "DATABASE_UNAVAILABLE" });
      res.status(503).json({ error: { code: "NOT_READY", message: "Service not ready" } });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
