import "dotenv/config";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadManualValidationFixtures } from "./manual-validation-fixtures.js";
import { assertLocalScriptTargets } from "./scriptTargetGuard.js";

/**
 * Removes Na Pista's OWN rows for the manual-validation organizations (ids
 * read from .fixtures/manual-validation.json — never fixed ids, never a
 * pattern that could match real tenants), children before parents, then
 * deletes the fixture file (it holds passwords/secrets). The Platform side
 * (organizations, memberships, credentials, Supabase Auth users) is removed
 * by UL Platform's `npm run mv:teardown` — run this one first.
 *
 * Usage: npm run mv:teardown
 */
const TABLES = [
  "appointments",
  "professional_schedule_exceptions",
  "professional_schedule_rules",
  "professional_services",
  "order_items",
  "orders",
  "stock_movements",
  "inventory_balances",
  "products",
  "categories",
  "customers",
  "professionals",
  "services",
  "organization_settings",
  "audit_events",
] as const;

assertLocalScriptTargets("mv:teardown", { NA_PISTA_DATABASE_URL: process.env.NA_PISTA_DATABASE_URL });

const fixtures = loadManualValidationFixtures();
const organizationIds = Object.values(fixtures.organizations).map((org) => org.id);
const { queryClient } = await import("../src/db/index.js");
try {
  await queryClient.begin(async (sql) => {
    for (const table of TABLES) {
      const rows = await sql`delete from ${sql("na_pista")}.${sql(table)} where organization_id = any(${organizationIds}::uuid[])`;
      if (rows.count > 0) console.log(`${table}: ${rows.count}`);
    }
  });
  rmSync(fileURLToPath(new URL("../.fixtures/manual-validation.json", import.meta.url)));
  console.log(`Removed Na Pista data for ${organizationIds.length} manual-validation organization(s) and the fixture file.`);
} finally {
  await queryClient.end();
}
