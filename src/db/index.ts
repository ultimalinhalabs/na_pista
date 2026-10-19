import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env.js";
import * as schema from "./schema/index.js";
import { assertSafeTestDatabaseUrl, isTestRun } from "./testDatabaseGuard.js";

// Fase 6 — a test run never connects to a non-local database (see testDatabaseGuard.ts).
if (isTestRun()) assertSafeTestDatabaseUrl(env.NA_PISTA_DATABASE_URL);

/**
 * Na Pista's OWN database connection — never UL Platform's (CLAUDE.md §2, ADR-002). `prepare: false`: on Vercel the
 * API connects through the Supavisor TRANSACTION pooler, which cannot keep named prepared statements across
 * transactions (same setting as ul-platform); equally correct on the session pooler / a direct connection (worker).
 */
export const queryClient = postgres(env.NA_PISTA_DATABASE_URL, { max: 5, idle_timeout: 20, prepare: false });

export const db = drizzle(queryClient, { schema });
