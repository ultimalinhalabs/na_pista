import { env } from "../config/env.js";
import { parseEncryptionKey } from "./credentialCrypto.js";

/**
 * F29A: the single accessor for NA_PISTA_CREDENTIAL_ENCRYPTION_KEY. Parsed
 * lazily on each call (cheap), so a missing key surfaces as a fail-closed
 * `CredentialCryptoError("KEY_MISSING")` at use time in development/test —
 * production never gets this far without a key (env.ts refuses to start).
 * Never logged, never returned outside src/security + src/modules/platformCredentials.
 */
export function getCredentialEncryptionKey(): Buffer {
  return parseEncryptionKey(env.NA_PISTA_CREDENTIAL_ENCRYPTION_KEY);
}
