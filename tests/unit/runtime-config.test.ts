import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DEVELOPMENT_DEFAULT_ORIGINS, parseAllowedOrigins } from "../../src/config/origins.js";

/**
 * Runtime readiness — configuration guards. Each startup case runs in a fresh child process that never
 * reads `.env` and uses only fictitious `.invalid` hosts or loopback URLs (no connection is opened by
 * loading the configuration). NODE_TEST_CONTEXT is removed so the child behaves like a real server
 * process rather than a test run.
 */
const KEY = Buffer.alloc(32, 7).toString("base64"); // a test-only constant, not a real key

function loadEnvInChild(vars: Record<string, string | undefined>) {
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: "/nonexistent/.env" };
  delete env.NODE_TEST_CONTEXT;
  for (const k of ["NA_PISTA_DATABASE_URL", "NA_PISTA_ALLOWED_ORIGINS", "NA_PISTA_PROVISIONING_CREDENTIAL", "NA_PISTA_CREDENTIAL_ENCRYPTION_KEY", "NODE_ENV", "PLATFORM_API_URL"]) delete env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) env[k] = v;
  return spawnSync(process.execPath, ["--import", "tsx", "-e", "await import('./src/config/env.ts'); console.log('ENV_LOADED')"], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
}
const base = { PLATFORM_API_URL: "http://127.0.0.1:9/v1" };
const loaded = (r: ReturnType<typeof loadEnvInChild>) => r.status === 0 && /ENV_LOADED/.test(r.stdout);

test("CORS origins: exact origins only, never a wildcard; production requires https", () => {
  assert.deepEqual(parseAllowedOrigins(DEVELOPMENT_DEFAULT_ORIGINS, "development"), { origins: ["http://localhost:3010"], problems: [] });
  assert.deepEqual(parseAllowedOrigins("https://a.example, https://b.example:8443", "production").problems, []);
  assert.ok(parseAllowedOrigins("*", "development").problems.length > 0);
  assert.ok(parseAllowedOrigins("https://*.example", "production").problems.length > 0);
  assert.ok(parseAllowedOrigins("https://a.example/app", "production").problems.length > 0, "no path");
  assert.ok(parseAllowedOrigins("https://a.example/", "production").problems.length > 0, "no trailing slash");
  assert.ok(parseAllowedOrigins("http://a.example", "production").problems.length > 0, "https only in production");
  assert.ok(parseAllowedOrigins("not an origin", "development").problems.length > 0);
  assert.ok(parseAllowedOrigins(" , ", "development").problems.length > 0, "empty list");
});

test("production: NA_PISTA_ALLOWED_ORIGINS is required (no default) and must be valid", () => {
  const prod = { ...base, NODE_ENV: "production", NA_PISTA_DATABASE_URL: "postgresql://u:p@db.prod.invalid:5432/x", NA_PISTA_CREDENTIAL_ENCRYPTION_KEY: KEY };
  const missing = loadEnvInChild(prod);
  assert.ok(!loaded(missing));
  assert.match(missing.stderr, /NA_PISTA_ALLOWED_ORIGINS/);
  assert.ok(!loaded(loadEnvInChild({ ...prod, NA_PISTA_ALLOWED_ORIGINS: "*" })));
  assert.ok(!loaded(loadEnvInChild({ ...prod, NA_PISTA_ALLOWED_ORIGINS: "http://localhost:3010" })), "the local default is not a production origin");
  assert.ok(loaded(loadEnvInChild({ ...prod, NA_PISTA_ALLOWED_ORIGINS: "https://app.na-pista.invalid" })), "a production database is accepted in production");
});

test("production starts without a provisioner credential; a malformed one is refused", () => {
  const prod = { ...base, NODE_ENV: "production", NA_PISTA_DATABASE_URL: "postgresql://u:p@db.prod.invalid:5432/x", NA_PISTA_CREDENTIAL_ENCRYPTION_KEY: KEY, NA_PISTA_ALLOWED_ORIGINS: "https://app.na-pista.invalid" };
  assert.ok(loaded(loadEnvInChild(prod)));
  const bad = loadEnvInChild({ ...prod, NA_PISTA_PROVISIONING_CREDENTIAL: "not-a-key" });
  assert.ok(!loaded(bad));
  assert.match(bad.stderr, /NA_PISTA_PROVISIONING_CREDENTIAL/);
  assert.doesNotMatch(bad.stderr, /not-a-key/, "the value itself is never printed");
});

test("outside production the runtime refuses any non-local database (fail closed, no override)", () => {
  for (const nodeEnv of ["development", "test"]) {
    const remote = loadEnvInChild({ ...base, NODE_ENV: nodeEnv, NA_PISTA_DATABASE_URL: "postgresql://u:p@db.prod.invalid:5432/x" });
    assert.ok(!loaded(remote), nodeEnv);
    assert.match(remote.stderr, /NA_PISTA_DATABASE_URL/);
    assert.doesNotMatch(remote.stderr, /db\.prod\.invalid|u:p@/, "the URL itself is never printed");
    const pooler = loadEnvInChild({ ...base, NODE_ENV: nodeEnv, NA_PISTA_DATABASE_URL: "postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres", TEST_DATABASE_ALLOW_REMOTE: "true" });
    assert.ok(!loaded(pooler), `${nodeEnv}: a Supabase pooler is refused even with the former override`);
    assert.ok(loaded(loadEnvInChild({ ...base, NODE_ENV: nodeEnv, NA_PISTA_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x" })), `${nodeEnv}: local is fine`);
  }
});
