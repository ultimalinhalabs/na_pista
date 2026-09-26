import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Shape of .fixtures/manual-validation.json, written by UL Platform's
 * `npm run mv:provision` (ul-platform/scripts/manual-validation-provision.ts).
 * Git-ignored: contains passwords and credential secrets.
 */
export type ReferenceKey = "PRODUCT_REFERENCE" | "SERVICE_REFERENCE";
export type RoleKey = "OWNER" | "ADMIN" | "MANAGER" | "STAFF";

export interface ManualValidationFixtures {
  createdAt: string;
  runId: string;
  platformBaseUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  organizations: Record<
    ReferenceKey,
    {
      id: string;
      name: string;
      displayLabel: string;
      users: Record<RoleKey, { id: string; email: string; password: string }>;
      credentials: Record<"platformFacing" | "integration", { keyId: string; secret: string; scopes: string[] }>;
    }
  >;
}

const fixturesPath = fileURLToPath(new URL("../.fixtures/manual-validation.json", import.meta.url));

export function loadManualValidationFixtures(): ManualValidationFixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("Manual-validation fixtures not found. Run `npm run mv:provision` in ul-platform (with its `npm run dev` running) first.");
  }
}
