import { isLocalHostname } from "../src/db/testDatabaseGuard.js";

/**
 * Dev-script target guard (F31 cleanup). The demo, manual-validation and
 * credential-bootstrap scripts create organizations, memberships,
 * subscriptions, API keys, credentials, catalog rows — or delete rows. They
 * load `.env`, whose NA_PISTA_DATABASE_URL may be a real database, so each
 * script calls this BEFORE any network call or database access.
 *
 * Fail closed, no override: every target must be a loopback URL
 * (localhost / 127.0.0.1 / ::1); missing or malformed targets and
 * NODE_ENV=production are refused. Pure: testable without a connection.
 *
 * Not covered here (by design — no cross-repository inspection): which
 * database the local UL Platform dev server behind PLATFORM_API_URL uses;
 * and the UL Auth (Supabase) sign-in, which reads a session and creates no
 * resource.
 */
export class UnsafeScriptTargetError extends Error {
  constructor(message: string) {
    super(`[script-target-guard] ${message}`);
    this.name = "UnsafeScriptTargetError";
  }
}

export function assertLocalScriptTargets(
  script: string,
  targets: Record<string, string | undefined>,
  envVars: NodeJS.ProcessEnv = process.env,
): void {
  if (envVars.NODE_ENV === "production") {
    throw new UnsafeScriptTargetError(`${script} refuses to run with NODE_ENV=production.`);
  }
  for (const [name, value] of Object.entries(targets)) {
    if (!value) throw new UnsafeScriptTargetError(`${script}: ${name} is not set — refusing to guess a target.`);
    let host: string;
    try {
      host = new URL(value).hostname;
    } catch {
      throw new UnsafeScriptTargetError(`${script}: ${name} is not a valid URL.`);
    }
    if (!isLocalHostname(host)) {
      throw new UnsafeScriptTargetError(
        `${script} refuses a non-local ${name} (${host}). Dev scripts only run against a local/disposable stack.`,
      );
    }
  }
}
