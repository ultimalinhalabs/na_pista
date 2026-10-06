import type { Response } from "express";
import type { ValidationIssue } from "./errors.js";
import type { Page } from "./listing.js";

export function ok<T>(res: Response, data: T, statusCode = 200) {
  return res.status(statusCode).json({ data });
}

export function fail(res: Response, statusCode: number, code: string, message: string, details?: ValidationIssue[]) {
  return res.status(statusCode).json({ error: { code, message, ...(details?.length ? { details } : {}) } });
}

/** ADR-051: `{ data: T[], pagination: { page, pageSize, total, totalPages } }` — `data` keeps the list's existing item shape. */
export function okPage<T>(res: Response, page: Page<T>) {
  return res.status(200).json({
    data: page.items,
    pagination: { page: page.page, pageSize: page.pageSize, total: page.total, totalPages: Math.ceil(page.total / page.pageSize) },
  });
}
