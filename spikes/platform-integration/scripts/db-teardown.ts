import "dotenv/config";
import postgres from "postgres";
import { env } from "../src/config/env.js";

/** Removes everything db-init.ts created. Run this to fully undo the spike's DB footprint. */
async function main() {
  const sql = postgres(env.NA_PISTA_DATABASE_URL, { max: 1 });
  try {
    await sql.unsafe(`drop schema if exists ${env.NA_PISTA_DB_SCHEMA} cascade`);
    console.log(`na-pista spike DB schema "${env.NA_PISTA_DB_SCHEMA}" dropped.`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("db:teardown failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
