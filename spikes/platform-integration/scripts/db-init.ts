import "dotenv/config";
import postgres from "postgres";
import { env } from "../src/config/env.js";

/**
 * Spike-only DDL (no drizzle-kit migration pipeline for something this
 * small and removable — F19 §3). Idempotent: safe to re-run.
 */
async function main() {
  const sql = postgres(env.NA_PISTA_DATABASE_URL, { max: 1 });
  const schema = env.NA_PISTA_DB_SCHEMA;
  try {
    await sql.unsafe(`create schema if not exists ${schema}`);
    await sql.unsafe(`
      create table if not exists ${schema}.products (
        id uuid primary key default gen_random_uuid(),
        organization_id uuid not null,
        name text not null,
        status text not null default 'ACTIVE' check (status in ('ACTIVE','ARCHIVED')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        constraint products_org_id_unique unique (organization_id, id)
      )
    `);
    await sql.unsafe(`create index if not exists products_org_idx on ${schema}.products (organization_id)`);
    console.log(`na-pista spike DB ready: schema "${schema}", table "products".`);
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error("db:init failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
