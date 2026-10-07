/**
 * Fase 6 — test database guard (same rule as UL Platform and QD). Under the Node test runner the
 * connection must be a LOCAL (loopback) database. Fail closed, no override: a remote database —
 * including the production one — is refused even if someone asks for it (the former
 * `TEST_DATABASE_ALLOW_REMOTE` escape hatch was removed for the production runtime). Pure: testable
 * without a connection.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Loopback only — shared with the dev-script target guard (scripts/scriptTargetGuard.ts) and config/env.ts. */
export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(`[test-database-guard] ${message}`);
    this.name = "UnsafeTestDatabaseError";
  }
}

export function isTestRun(argv: string[] = process.argv, envVars: NodeJS.ProcessEnv = process.env): boolean {
  return envVars.NODE_TEST_CONTEXT != null || argv.includes("--test");
}

export function assertSafeTestDatabaseUrl(databaseUrl: string): void {
  let host: string;
  try {
    host = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    throw new UnsafeTestDatabaseError("NA_PISTA_DATABASE_URL is not a valid connection URL.");
  }
  if (!isLocalHostname(host)) {
    throw new UnsafeTestDatabaseError(
      `refusing to run tests against a non-local database (${host}). Point NA_PISTA_DATABASE_URL at a local/disposable Postgres.`,
    );
  }
}
