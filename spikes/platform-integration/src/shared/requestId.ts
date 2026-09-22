import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/** Same validation as ul-platform's middleware/requestId.ts — a client-supplied id is honored only if it looks safe. */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function requestId(req: Request, res: Response, next: NextFunction) {
  const supplied = req.header("x-request-id");
  const id = supplied && VALID_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-ID", id);
  next();
}
