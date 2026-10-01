import type { Response } from "express";
import type { ValidationIssue } from "./errors.js";

export function ok<T>(res: Response, data: T, statusCode = 200) {
  return res.status(statusCode).json({ data });
}

export function fail(res: Response, statusCode: number, code: string, message: string, details?: ValidationIssue[]) {
  return res.status(statusCode).json({ error: { code, message, ...(details?.length ? { details } : {}) } });
}
