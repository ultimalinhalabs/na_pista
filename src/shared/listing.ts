import { asc, desc, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";

/**
 * ADR-051 (pagination) and ADR-052 (sorting) — the shared query fields and
 * helpers every paginated list uses. Defaults and maxima stay per endpoint
 * (unchanged from before F30), so a request without page parameters returns
 * exactly the rows it returned before.
 */
export const MAX_PAGE = 10_000;

export function pageFields(defaultPageSize: number, maxPageSize: number) {
  return {
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1).meta({ description: "1-based page number." }),
    pageSize: z.coerce
      .number()
      .int()
      .positive()
      .max(maxPageSize)
      .optional()
      .meta({ description: `Rows per page (default ${defaultPageSize}, max ${maxPageSize}).` }),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(maxPageSize)
      .optional()
      .meta({ deprecated: true, description: "Deprecated alias of `pageSize` (kept for compatibility). Do not send both." }),
  };
}

/** Use with `.refine(...pageSizeOrLimit)` on the list query schema. */
export const pageSizeOrLimit: [
  (query: { pageSize?: number; limit?: number }) => boolean,
  { message: string; path: PropertyKey[] },
] = [
  (query) => query.pageSize === undefined || query.limit === undefined,
  { message: "Send either pageSize or limit (deprecated alias), not both", path: ["limit"] },
];

export function sortFields<const F extends readonly [string, ...string[]]>(fields: F, defaultField: F[number], defaultOrder: "asc" | "desc") {
  return {
    sort: z.enum(fields).optional().meta({ description: `Sort field (default ${defaultField}).` }),
    order: z.enum(["asc", "desc"]).optional().meta({ description: `Sort direction (default ${defaultOrder}).` }),
  };
}

export interface PageRequest {
  page: number;
  pageSize: number;
  offset: number;
}

export function pageRequest(query: { page?: number; pageSize?: number; limit?: number }, defaultPageSize: number): PageRequest {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? query.limit ?? defaultPageSize;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * ADR-052: ORDER BY `<allowlisted column> <dir>, id <dir>` — total and
 * deterministic. The column comes from a code-side map keyed by an enum the
 * request schema already validated; client text never reaches SQL as an
 * identifier.
 */
export function orderByAllowlisted<K extends string>(
  columns: Record<K, AnyColumn>,
  idColumn: AnyColumn,
  sort: K,
  order: "asc" | "desc",
): SQL[] {
  const dir = order === "asc" ? asc : desc;
  return [dir(columns[sort]), dir(idColumn)];
}

/** ILIKE substring with the user's `%`, `_` and `\` matched literally (not as wildcards). */
export function likeSubstring(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
