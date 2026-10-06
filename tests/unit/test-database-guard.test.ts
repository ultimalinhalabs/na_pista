import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertSafeTestDatabaseUrl, isTestRun, UnsafeTestDatabaseError } from "../../src/db/testDatabaseGuard.js";

test("test database guard: local hosts pass, remote hosts are refused unless explicitly allowed", () => {
  assert.equal(isTestRun(["node", "--test"], {}), true);
  for (const url of ["postgres://u:p@localhost:5432/x", "postgres://u:p@127.0.0.1/x", "postgres://u:p@[::1]:5432/x"]) {
    assert.doesNotThrow(() => assertSafeTestDatabaseUrl(url));
  }
  assert.throws(() => assertSafeTestDatabaseUrl("postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres"), UnsafeTestDatabaseError);
  assert.throws(() => assertSafeTestDatabaseUrl("not a url"), UnsafeTestDatabaseError);
  assert.doesNotThrow(() => assertSafeTestDatabaseUrl("postgres://u:p@db.remote.invalid/x", "true"));
});

/**
 * The guard must act where the connection is created (src/db/index.ts), before any query, and also
 * in child processes started by tests (e2e startChildServer). Only fictitious `.invalid` hosts or an
 * unreachable local port are used — never a real database. Each case runs in a fresh child process
 * (no module cache), inheriting this test run's context (NODE_TEST_CONTEXT) exactly as e2e servers do.
 */
function importDbInChild(databaseUrl: string | undefined, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: "/nonexistent/.env", // never read the real .env
    PLATFORM_API_URL: "http://127.0.0.1:9/v1",
    ...extraEnv,
  };
  if (databaseUrl === undefined) delete env.NA_PISTA_DATABASE_URL;
  else env.NA_PISTA_DATABASE_URL = databaseUrl;
  delete env.TEST_DATABASE_ALLOW_REMOTE;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./src/db/index.ts'); console.log('DB_MODULE_LOADED')"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}

test("guard runs at connection creation: a remote database is refused before any connection (also in a child process)", () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "the test runner provides NODE_TEST_CONTEXT, which child processes inherit");
  const r = importDbInChild("postgres://u:p@db.remote.invalid:5432/x");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /test-database-guard\] refusing to run tests against a non-local database/);
  assert.doesNotMatch(r.stdout, /DB_MODULE_LOADED/);
});

test("a local test database is allowed (module loads; no connection is opened by importing it)", () => {
  const r = importDbInChild("postgres://nobody@127.0.0.1:1/unreachable");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DB_MODULE_LOADED/);
});

test("no database URL at all → fail closed (startup refuses)", () => {
  const r = importDbInChild(undefined);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /DB_MODULE_LOADED/);
});

test("TEST_DATABASE_ALLOW_REMOTE other than exactly 'true' does not open the remote path", () => {
  const r = importDbInChild("postgres://u:p@db.remote.invalid:5432/x", { TEST_DATABASE_ALLOW_REMOTE: "yes" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /test-database-guard/);
});
