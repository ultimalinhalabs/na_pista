import "dotenv/config";
import { defineConfig } from "drizzle-kit";
import { isLocalHostname } from "./src/db/testDatabaseGuard.js";

if (!process.env.NA_PISTA_DATABASE_URL) {
  throw new Error("NA_PISTA_DATABASE_URL is required to run drizzle-kit");
}

// drizzle-kit (generate/migrate/studio/push) is a LOCAL development tool: it reads `.env` and must never
// reach the production database. Production migrations go through the audited, owner-authorized
// procedure (exact committed blobs, dry-run of the pending set) — never through drizzle-kit. Fail closed.
let drizzleKitHost = "";
try {
  drizzleKitHost = new URL(process.env.NA_PISTA_DATABASE_URL).hostname;
} catch {
  throw new Error("NA_PISTA_DATABASE_URL is not a valid connection URL");
}
if (!isLocalHostname(drizzleKitHost)) {
  throw new Error("drizzle-kit only runs against a local (loopback) database — refusing a remote NA_PISTA_DATABASE_URL");
}

/**
 * `schemaFilter` restricts drizzle-kit to Na Pista's own schema
 * (`NA_PISTA_DB_SCHEMA`, default `na_pista`). In this environment there is
 * no separate Postgres instance available (see docs/decisions.md OD-16 /
 * ADR-015) so Na Pista's database currently lives on the same physical
 * Postgres server as UL Platform's — under a dedicated schema, never
 * shared tables, never referenced by the Platform. drizzle-kit must never
 * introspect or migrate anything outside that schema.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle/migrations",
  schemaFilter: [process.env.NA_PISTA_DB_SCHEMA ?? "na_pista"],
  // Keeps drizzle-kit's own migration-tracking table out of the `drizzle`
  // schema UL Platform's own drizzle-kit already uses on this same
  // physical Postgres server (docs/decisions.md OD-16) — internal
  // tooling bookkeeping, not business data, but still worth not sharing.
  migrations: {
    schema: "na_pista_drizzle_meta",
  },
  dbCredentials: {
    url: process.env.NA_PISTA_DATABASE_URL,
  },
});
