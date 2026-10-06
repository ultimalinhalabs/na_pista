import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";
import { assertSafeTestDatabaseUrl, isTestRun } from "./testDatabaseGuard.js";

// Fase 6 — a test run never connects to a non-local database (see testDatabaseGuard.ts).
if (isTestRun()) assertSafeTestDatabaseUrl(env.NA_PISTA_DATABASE_URL, process.env.TEST_DATABASE_ALLOW_REMOTE);

/** Na Pista's OWN database connection — never UL Platform's (CLAUDE.md §2, ADR-002). */
export const queryClient = postgres(env.NA_PISTA_DATABASE_URL, { max: 5, idle_timeout: 20 });

export const db = drizzle(queryClient, { schema });
