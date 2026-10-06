import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { CredentialCryptoError, decryptCredential, encryptCredential, parseEncryptionKey } from "../../src/security/credentialCrypto.js";

/**
 * F29A: authenticated encryption for Platform credentials at rest. Pure —
 * no env, no DB, no network. Keys and plaintexts here are generated per
 * run; nothing real is used or printed.
 */
const key = randomBytes(32);
const orgA = randomUUID();
const orgB = randomUUID();
const secret = `ulk_${randomUUID()}.${randomBytes(24).toString("base64url")}`;

function failsWith(fn: () => unknown, reason: string) {
  assert.throws(fn, (error: unknown) => error instanceof CredentialCryptoError && error.reason === reason);
}

test("round trip: decrypt(encrypt(x)) === x for the same organization and key", () => {
  assert.equal(decryptCredential(encryptCredential(secret, orgA, key), orgA, key), secret);
});

test("envelope is versioned v1:<iv>:<tag>:<ciphertext> and never contains the plaintext", () => {
  const envelope = encryptCredential(secret, orgA, key);
  const parts = envelope.split(":");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], "v1");
  assert.ok(!envelope.includes(secret));
  assert.ok(!envelope.includes(secret.slice(4, 20)));
});

test("same plaintext encrypts differently every time (fresh IV)", () => {
  const a = encryptCredential(secret, orgA, key);
  const b = encryptCredential(secret, orgA, key);
  assert.notEqual(a, b);
  assert.notEqual(a.split(":")[1], b.split(":")[1]);
});

test("tampered ciphertext, tag or IV fails authentication", () => {
  const [v, iv, tag, data] = encryptCredential(secret, orgA, key).split(":") as [string, string, string, string];
  const flip = (b64: string) => {
    const buf = Buffer.from(b64, "base64url");
    buf[0] = buf[0]! ^ 0x01;
    return buf.toString("base64url");
  };
  failsWith(() => decryptCredential([v, iv, tag, flip(data)].join(":"), orgA, key), "AUTHENTICATION_FAILED");
  failsWith(() => decryptCredential([v, iv, flip(tag), data].join(":"), orgA, key), "AUTHENTICATION_FAILED");
  failsWith(() => decryptCredential([v, flip(iv), tag, data].join(":"), orgA, key), "AUTHENTICATION_FAILED");
});

test("tenant binding (AAD): organization B cannot decrypt organization A's ciphertext", () => {
  failsWith(() => decryptCredential(encryptCredential(secret, orgA, key), orgB, key), "AUTHENTICATION_FAILED");
});

test("a different key cannot decrypt", () => {
  failsWith(() => decryptCredential(encryptCredential(secret, orgA, key), orgA, randomBytes(32)), "AUTHENTICATION_FAILED");
});

test("malformed or unsupported envelopes fail without decrypting", () => {
  failsWith(() => decryptCredential("not-an-envelope", orgA, key), "MALFORMED");
  failsWith(() => decryptCredential("v1:a:b", orgA, key), "MALFORMED");
  const [, iv, tag, data] = encryptCredential(secret, orgA, key).split(":");
  failsWith(() => decryptCredential(["v2", iv, tag, data].join(":"), orgA, key), "UNSUPPORTED_VERSION");
});

test("missing or wrong-length key fails appropriately", () => {
  failsWith(() => parseEncryptionKey(undefined), "KEY_MISSING");
  failsWith(() => parseEncryptionKey(""), "KEY_MISSING");
  failsWith(() => parseEncryptionKey(randomBytes(16).toString("base64")), "KEY_INVALID");
  assert.equal(parseEncryptionKey(key.toString("base64")).length, 32);
  failsWith(() => encryptCredential(secret, orgA, randomBytes(16)), "KEY_INVALID");
});

test("errors carry a reason code only — no key, ciphertext or plaintext in the message", () => {
  const envelope = encryptCredential(secret, orgA, key);
  try {
    decryptCredential(envelope, orgB, key);
    assert.fail("should have thrown");
  } catch (error) {
    const text = `${(error as Error).message} ${(error as Error).stack ?? ""}`;
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(envelope.split(":")[3]!));
    assert.ok(!text.includes(key.toString("base64")));
  }
});
