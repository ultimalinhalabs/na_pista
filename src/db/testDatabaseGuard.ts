/**
 * Fase 6 — test database guard (same rule as UL Platform and QD). `config/env.ts`
 * loads `.env` via `dotenv/config`, whose NA_PISTA_DATABASE_URL is a real
 * database; under the Node test runner the connection must be a LOCAL
 * database, unless `TEST_DATABASE_ALLOW_REMOTE=true` explicitly opts into a
 * remote database dedicated to tests. Pure: testable without a connection.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(`[test-database-guard] ${message}`);
    this.name = "UnsafeTestDatabaseError";
  }
}

export function isTestRun(argv: string[] = process.argv, envVars: NodeJS.ProcessEnv = process.env): boolean {
  return envVars.NODE_TEST_CONTEXT != null || argv.includes("--test");
}

export function assertSafeTestDatabaseUrl(databaseUrl: string, allowRemote?: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new UnsafeTestDatabaseError("NA_PISTA_DATABASE_URL is not a valid connection URL.");
  }
  if (!LOCAL_HOSTS.has(host) && allowRemote !== "true") {
    throw new UnsafeTestDatabaseError(
      `refusing to run tests against a non-local database (${host}). Point NA_PISTA_DATABASE_URL at a local/disposable Postgres, ` +
        "or set TEST_DATABASE_ALLOW_REMOTE=true only for a remote database dedicated to tests.",
    );
  }
}
