/**
 * F29A restart simulation helper — run as a separate process by
 * tests/integration/platformCredentials.test.ts. A brand-new Node process
 * has an empty in-memory registry by construction; this resolves the
 * organization's credential purely from PostgreSQL + the env key and prints
 * a SHA-256 of it (never the credential itself).
 */
import { createHash } from "node:crypto";
import { queryClient } from "../../../src/db/index.js";
import { resolvePlatformCredential } from "../../../src/modules/platformCredentials/resolver.js";
import { registeredServiceCredentialCount } from "../../../src/platform/serviceAuth.js";

const organizationId = process.argv[2];
if (!organizationId) throw new Error("usage: resolveInFreshProcess.ts <organizationId>");

try {
  const credential = await resolvePlatformCredential(organizationId);
  console.log(
    JSON.stringify({
      registered: registeredServiceCredentialCount(),
      sha256: createHash("sha256").update(credential).digest("hex"),
    }),
  );
} finally {
  await queryClient.end();
}
