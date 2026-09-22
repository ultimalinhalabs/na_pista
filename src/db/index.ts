import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";

/** Na Pista's OWN database connection — never UL Platform's (CLAUDE.md §2, ADR-002). */
export const queryClient = postgres(env.NA_PISTA_DATABASE_URL, { max: 5, idle_timeout: 20 });

export const db = drizzle(queryClient, { schema });
