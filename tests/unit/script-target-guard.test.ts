import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertLocalScriptTargets, UnsafeScriptTargetError } from "../../scripts/scriptTargetGuard.js";

const LOCAL = {
  NA_PISTA_DATABASE_URL: "postgres://u:p@localhost:5432/na_pista_dev",
  NA_PISTA_API_URL: "http://127.0.0.1:4200/v1",
  PLATFORM_API_URL: "http://[::1]:4000/v1",
};

test("script target guard: loopback targets pass", () => {
  assert.doesNotThrow(() => assertLocalScriptTargets("demo", LOCAL, {}));
});

test("script target guard: remote, Supabase, missing, malformed and production are refused", () => {
  const refused: Array<[Record<string, string | undefined>, NodeJS.ProcessEnv]> = [
    [{ ...LOCAL, NA_PISTA_DATABASE_URL: "postgres://u:p@db.remote.invalid:5432/x" }, {}],
    [{ ...LOCAL, NA_PISTA_DATABASE_URL: "postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres" }, {}],
    [{ ...LOCAL, PLATFORM_API_URL: "https://api.remote.invalid/v1" }, {}],
    [{ ...LOCAL, NA_PISTA_API_URL: "https://na-pista.remote.invalid/v1" }, {}],
    [{ ...LOCAL, NA_PISTA_DATABASE_URL: undefined }, {}],
    [{ ...LOCAL, NA_PISTA_DATABASE_URL: "" }, {}],
    [{ ...LOCAL, NA_PISTA_DATABASE_URL: "not a url" }, {}],
    [LOCAL, { NODE_ENV: "production" }],
  ];
  for (const [targets, envVars] of refused) {
    assert.throws(() => assertLocalScriptTargets("demo", targets, envVars), UnsafeScriptTargetError);
  }
});

/**
 * Each script must refuse BEFORE reading fixtures, calling an API or touching a database. Runs the real
 * scripts in child processes with fictitious `.invalid` hosts (or NODE_ENV=production with loopback
 * targets) — never the real `.env` (DOTENV_CONFIG_PATH points nowhere), never a real database or API.
 */
const SCRIPTS = [
  "scripts/demo-o-partir-do-pao.ts",
  "scripts/manual-validation-seed.ts",
  "scripts/manual-validation-teardown.ts",
  "scripts/manual-validation-server.ts",
  "scripts/provision-platform-credentials.ts",
];

function runScript(script: string, overrides: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: "/nonexistent/.env", ...LOCAL, ...overrides };
  delete env.PORT;
  return spawnSync(process.execPath, ["--import", "tsx", script], { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000 });
}

for (const script of SCRIPTS) {
  test(`${script}: a remote database is refused before anything runs`, () => {
    const r = runScript(script, { NA_PISTA_DATABASE_URL: "postgres://u:p@db.remote.invalid:5432/x", NODE_ENV: "development" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[script-target-guard\] .* refuses a non-local NA_PISTA_DATABASE_URL \(db\.remote\.invalid\)/);
    assert.equal(r.stdout.trim(), "", "nothing may be printed (no fixture read, no call, no row) before the guard");
  });

  test(`${script}: NODE_ENV=production is refused even with local targets`, () => {
    const r = runScript(script, { NODE_ENV: "production" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[script-target-guard\] .* refuses to run with NODE_ENV=production/);
    assert.equal(r.stdout.trim(), "");
  });
}

test("demo and mv:seed also refuse a remote Na Pista API or UL Platform API", () => {
  for (const script of ["scripts/demo-o-partir-do-pao.ts", "scripts/manual-validation-seed.ts"]) {
    const remoteApis = [
      ["NA_PISTA_API_URL", "https://na-pista.remote.invalid/v1"],
      ["PLATFORM_API_URL", "https://api.remote.invalid/v1"],
    ] as const;
    for (const [name, value] of remoteApis) {
      const r = runScript(script, { [name]: value, NODE_ENV: "development" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, new RegExp(`refuses a non-local ${name}`));
    }
  }
});
