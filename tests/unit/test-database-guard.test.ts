import assert from "node:assert/strict";
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
