import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { ok } from "../../shared/response.js";
import { reconcileOnDemand } from "./reconciler.js";

/**
 * Daily safety net for on-demand provisioning (owner decision 2026-10-18 — no 24/7 worker): Vercel Cron calls
 * GET /v1/internal/cron/reconcile-provisioning with `Authorization: Bearer <CRON_SECRET>`. It runs one reconcile
 * cycle (confirms held credentials, pulls open requests, retires refused ones). Without CRON_SECRET the route does
 * not exist (404); a wrong secret is 404 too — its existence is never disclosed. The response carries counts only.
 */
function authorized(header: string | undefined): boolean {
  const secret = env.CRON_SECRET;
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function cronReconcileHandler(req: Request, res: Response) {
  if (!authorized(req.get("authorization"))) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
    return;
  }
  const result = await reconcileOnDemand("cron", { force: true });
  res.set("Cache-Control", "no-store");
  ok(res, { ran: result !== null, ...(result ?? {}) });
}
