import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

/**
 * Na Pista's OWN database connection — never UL Platform's (CLAUDE.md §2,
 * ADR-002). See .env.example and docs/decisions.md ADR-015 for why, in
 * THIS environment, that means a dedicated schema on the same physical
 * Postgres server rather than a fully separate instance.
 */
export const queryClient = postgres(env.NA_PISTA_DATABASE_URL, {
  max: 5,
  connect_timeout: 5,
});

export const db = drizzle(queryClient, { schema });
