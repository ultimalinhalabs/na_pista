import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * F29A dev bootstrap: stores each fixture organization's platform-facing
 * UL Platform credential in Na Pista's database — introspected by the real
 * Platform, encrypted (NA_PISTA_CREDENTIAL_ENCRYPTION_KEY), audited — so a
 * plain `npm run dev` / `npm start` serves those organizations with no
 * in-memory registration (replaces the need for `npm run mv:server`).
 *
 * Source: the git-ignored fixture written by ul-platform's provisioning
 * (`npm run mv:provision`). Default `.fixtures/manual-validation.json`;
 * `--fixtures <path>` for another file of the same shape.
 *
 * Idempotent: re-running leaves already-provisioned organizations
 * unchanged. Never overwrites a different active credential and never
 * reactivates a revoked one (those report CONFLICT). Prints organization
 * ids and outcomes only — never a secret, never the ciphertext.
 *
 * Usage: npm run credentials:provision [-- --fixtures .fixtures/other.json]
 */
interface FixtureOrganization {
  id: string;
  credentials?: { platformFacing?: { secret?: string } };
}

const args = process.argv.slice(2);
const fixturesArg = args[args.indexOf("--fixtures") + 1];
const fixturesPath = resolve(args.includes("--fixtures") && fixturesArg ? fixturesArg : ".fixtures/manual-validation.json");

let organizations: Record<string, FixtureOrganization>;
try {
  organizations = (JSON.parse(readFileSync(fixturesPath, "utf8")) as { organizations: Record<string, FixtureOrganization> }).organizations;
} catch {
  console.error(`Could not read organizations from ${fixturesPath}. Run \`npm run mv:provision\` in ul-platform first.`);
  process.exit(1);
}

const { provisionPlatformCredential } = await import("../src/modules/platformCredentials/service.js");
const { AppError } = await import("../src/shared/errors.js");
const { queryClient } = await import("../src/db/index.js");

const actor = { type: "service" as const, id: "system:credential-provisioning-script" };
let failed = 0;

try {
  for (const [label, org] of Object.entries(organizations)) {
    const secret = org.credentials?.platformFacing?.secret;
    if (!secret) {
      console.log(`${label} ${org.id}: SKIPPED (no platform-facing credential in fixture)`);
      continue;
    }
    try {
      const { outcome } = await provisionPlatformCredential({ organizationId: org.id, credential: secret }, { actor, requestId: "credentials:provision" });
      console.log(`${label} ${org.id}: ${outcome}`);
    } catch (error) {
      failed++;
      // AppError messages are written to be safe (no secret); anything else is reported by name only.
      const detail = error instanceof AppError ? `${error.code}: ${error.message}` : error instanceof Error ? error.name : "unknown error";
      console.log(`${label} ${org.id}: FAILED (${detail})`);
    }
  }
} finally {
  await queryClient.end();
}

process.exit(failed ? 1 : 0);
