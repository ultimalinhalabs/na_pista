import "dotenv/config";
import { loadManualValidationFixtures } from "./manual-validation-fixtures.js";

/**
 * DEV-ONLY launcher for manual validation (docs/manual-validation.md).
 *
 * F29A: no longer required — credentials are persisted in PostgreSQL
 * (`npm run credentials:provision`, then plain `npm run dev`). Kept for
 * compatibility; its in-memory registrations are only honoured for
 * organizations with no persisted credential row, never in production.
 *
 * Why this exists: Na Pista resolves entitlements/usage with a per-organization
 * platform credential held in an in-memory registry
 * (src/platform/serviceAuth.ts). Nothing in `src/` populates that registry
 * outside tests, so a plain `npm run dev` answers every tenant request with
 * 503 UPSTREAM_UNAVAILABLE. Fixing that is a backend change (credential
 * storage/provisioning — see docs/f29-report.md "Open gaps") and is out of
 * F29's scope, so this script does exactly what the E2E harness does:
 * registers the fixture organizations' platform-facing credentials, then
 * starts the unchanged server (src/server.ts) in the same process.
 *
 * Never use this for anything but local manual validation.
 *
 * Usage: npm run mv:server
 */
const fixtures = loadManualValidationFixtures();
const { registerServiceCredential } = await import("../src/platform/serviceAuth.js");
for (const [key, org] of Object.entries(fixtures.organizations)) {
  registerServiceCredential(org.id, org.credentials.platformFacing.secret);
  console.log(`registered platform credential for ${key} (${org.id})`);
}
await import("../src/server.js");
