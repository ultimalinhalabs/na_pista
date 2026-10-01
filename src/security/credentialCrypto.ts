import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * F29A: authenticated encryption for Platform credentials at rest.
 *
 * AES-256-GCM from Node's own `crypto` — no custom cryptography — following
 * the convention ul-platform already established for its webhook secrets
 * (modules/webhooks/crypto.ts: 12-byte IV, base64 32-byte key from env),
 * re-implemented here rather than imported (independent repositories), with
 * two additions:
 *
 *  - a version prefix, so the format/key can be rotated later without
 *    guessing what an old row contains;
 *  - Additional Authenticated Data binding each ciphertext to its
 *    organization. A ciphertext copied into another organization's row
 *    fails authentication instead of decrypting to someone else's secret —
 *    tenant isolation enforced cryptographically, not only by queries.
 *
 * Envelope: `v1:<iv>:<authTag>:<ciphertext>` (base64url parts).
 *
 * Errors are deliberately generic (`CredentialCryptoError` with a reason
 * code only): they never carry key material, ciphertext or plaintext, so
 * they are safe to log.
 */
const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export type CredentialCryptoFailure = "KEY_MISSING" | "KEY_INVALID" | "MALFORMED" | "UNSUPPORTED_VERSION" | "AUTHENTICATION_FAILED";

export class CredentialCryptoError extends Error {
  constructor(public readonly reason: CredentialCryptoFailure) {
    super(`Credential encryption failure: ${reason}`);
    this.name = "CredentialCryptoError";
  }
}

/** Decodes a base64 key and checks its length. `undefined`/empty → KEY_MISSING. */
export function parseEncryptionKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new CredentialCryptoError("KEY_MISSING");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) throw new CredentialCryptoError("KEY_INVALID");
  return key;
}

function associatedData(organizationId: string): Buffer {
  return Buffer.from(`na-pista/platform-credential/${VERSION}/${organizationId}`, "utf8");
}

export function encryptCredential(plaintext: string, organizationId: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new CredentialCryptoError("KEY_INVALID");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(organizationId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptCredential(envelope: string, organizationId: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new CredentialCryptoError("KEY_INVALID");
  const parts = envelope.split(":");
  if (parts.length !== 4) throw new CredentialCryptoError("MALFORMED");
  const [version, ivPart, tagPart, dataPart] = parts as [string, string, string, string];
  if (version !== VERSION) throw new CredentialCryptoError("UNSUPPORTED_VERSION");

  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const data = Buffer.from(dataPart, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16 || data.length === 0) throw new CredentialCryptoError("MALFORMED");

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(associatedData(organizationId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key, wrong organization (AAD), or a tampered IV/tag/ciphertext —
    // GCM cannot tell which, and neither should the caller.
    throw new CredentialCryptoError("AUTHENTICATION_FAILED");
  }
}
