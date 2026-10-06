import { db } from "../../db/index.js";
import { callPlatform } from "../../platform/client.js";
import { encryptCredential } from "../../security/credentialCrypto.js";
import { getCredentialEncryptionKey } from "../../security/credentialKey.js";
import { ConflictError, isUniqueViolationError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { recordAuditEvent } from "../audit/service.js";
import { invalidatePlatformCredentialCache } from "./resolver.js";
import {
  findByPlatformKey,
  findCurrentCredential,
  insertActiveCredential,
  revokeActiveCredential,
  toStatus,
  type PlatformCredentialStatus,
} from "./repository.js";

/**
 * F29A provisioning — the ONLY way a Platform credential enters Na Pista's
 * database. Explicit and server-side: never called from a GET, never at
 * startup, never implicitly by the resolver.
 *
 * Integration point: Na Pista cannot mint Platform keys itself (it holds no
 * user/admin authority on the Platform). Today the credential is minted by
 * the Platform (an OWNER, or the Platform's provisioning scripts) and handed
 * to this service — see scripts/provision-platform-credentials.ts. The
 * future hook is subscription activation on the Platform (webhook or an
 * OWNER-initiated "activate Na Pista" flow) calling this same function.
 *
 * Idempotent: provisioning the key that is already ACTIVE for the
 * organization is a no-op. It never overwrites a different ACTIVE key
 * (that requires `replaceActive`, an explicit rotation) and never
 * resurrects a REVOKED one.
 */
export const APPLICATION_KEY = "NA_PISTA";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ProvisioningActor {
  type: "user" | "service";
  id: string;
}

export type ProvisionOutcome = "PROVISIONED" | "UNCHANGED" | "ROTATED";

export interface ProvisionResult {
  outcome: ProvisionOutcome;
  status: PlatformCredentialStatus;
}

export interface PlatformKeyIdentity {
  apiKeyId: string;
  application: string;
  organizationId: string | null;
}

/** Test seam: how a presented credential is identified. Production asks the Platform itself. */
export type IdentifyCredential = (credential: string, requestId?: string) => Promise<PlatformKeyIdentity>;

const identifyWithPlatform: IdentifyCredential = async (credential, requestId) => {
  const res = await callPlatform<PlatformKeyIdentity>("GET", "/service/me", { token: credential, requestId });
  if (res.status !== 200 || !res.data) {
    throw new ValidationError("The Platform did not accept this credential (invalid, revoked or expired)");
  }
  return res.data;
};

export interface ProvisionOptions {
  actor: ProvisioningActor;
  /** Explicit rotation: revoke the organization's current ACTIVE credential and store this one, atomically. */
  replaceActive?: boolean;
  requestId?: string;
  identify?: IdentifyCredential;
  key?: () => Buffer;
}

export async function provisionPlatformCredential(
  input: { organizationId: string; credential: string },
  opts: ProvisionOptions,
): Promise<ProvisionResult> {
  const { organizationId, credential } = input;
  if (!UUID.test(organizationId)) throw new ValidationError("organizationId must be a UUID");
  if (!credential) throw new ValidationError("A credential is required");

  // 1. The Platform itself says which organization and application this key belongs to.
  const identity = await (opts.identify ?? identifyWithPlatform)(credential, opts.requestId);
  if (identity.organizationId !== organizationId) {
    throw new ValidationError("This credential does not belong to this organization");
  }
  if (identity.application !== APPLICATION_KEY) {
    throw new ValidationError(`This credential is not a ${APPLICATION_KEY} credential`);
  }

  // 2. Encrypt before opening the transaction (a missing key fails here, closed, before any write).
  const encryptedCredential = encryptCredential(credential, organizationId, (opts.key ?? getCredentialEncryptionKey)());

  try {
    const result = await db.transaction(async (tx) => {
      const sameKey = await findByPlatformKey(organizationId, identity.apiKeyId, tx);
      if (sameKey?.status === "ACTIVE") return { outcome: "UNCHANGED" as const, status: toStatus(sameKey) };
      if (sameKey?.status === "REVOKED") {
        throw new ConflictError("This credential was revoked for this organization and cannot be reactivated; provision a new one");
      }

      const current = await findCurrentCredential(organizationId, tx);
      let outcome: ProvisionOutcome = "PROVISIONED";
      if (current?.status === "ACTIVE") {
        if (!opts.replaceActive) {
          throw new ConflictError("This organization already has an active Platform credential; rotate it explicitly");
        }
        await revokeActiveCredential(organizationId, tx);
        await recordAuditEvent(
          {
            organizationId,
            actorType: opts.actor.type,
            actorId: opts.actor.id,
            action: "platform_credential.revoked",
            resourceType: "platform_credential",
            resourceId: current.id,
            metadata: { platformApiKeyId: current.platformApiKeyId, reason: "rotated" },
            requestId: opts.requestId,
          },
          tx,
        );
        outcome = "ROTATED";
      }

      const row = await insertActiveCredential({ organizationId, platformApiKeyId: identity.apiKeyId, encryptedCredential }, tx);
      await recordAuditEvent(
        {
          organizationId,
          actorType: opts.actor.type,
          actorId: opts.actor.id,
          action: outcome === "ROTATED" ? "platform_credential.rotated" : "platform_credential.provisioned",
          resourceType: "platform_credential",
          resourceId: row.id,
          // Metadata only — never the credential, never the ciphertext.
          metadata: { platformApiKeyId: row.platformApiKeyId, status: row.status },
          requestId: opts.requestId,
        },
        tx,
      );
      logger.info("platform_credential.provisioned", { organizationId, outcome, requestId: opts.requestId });
      return { outcome, status: toStatus(row) };
    });
    invalidatePlatformCredentialCache(organizationId);
    return result;
  } catch (error) {
    // A concurrent provision for the same organization lost the race on
    // the partial unique index (or the Platform key UNIQUE). Re-read: the
    // winner may have stored this very key (→ idempotent), or another one.
    if (isUniqueViolationError(error)) {
      const winner = await findByPlatformKey(organizationId, identity.apiKeyId);
      if (winner?.status === "ACTIVE") return { outcome: "UNCHANGED", status: toStatus(winner) };
      throw new ConflictError("A concurrent provisioning stored a different credential for this organization");
    }
    throw error;
  }
}

/**
 * Stops Na Pista from using the organization's credential. Does NOT revoke
 * the key on the Platform (Na Pista has no authority to) — the OWNER must
 * also revoke it there. A revoked row is kept and never reactivated.
 */
export async function revokePlatformCredential(
  organizationId: string,
  opts: { actor: ProvisioningActor; requestId?: string; reason?: string },
): Promise<PlatformCredentialStatus> {
  if (!UUID.test(organizationId)) throw new ValidationError("organizationId must be a UUID");
  const status = await db.transaction(async (tx) => {
    const row = await revokeActiveCredential(organizationId, tx);
    if (!row) throw new NotFoundError("This organization has no active Platform credential");
    await recordAuditEvent(
      {
        organizationId,
        actorType: opts.actor.type,
        actorId: opts.actor.id,
        action: "platform_credential.revoked",
        resourceType: "platform_credential",
        resourceId: row.id,
        metadata: { platformApiKeyId: row.platformApiKeyId, ...(opts.reason ? { reason: opts.reason } : {}) },
        requestId: opts.requestId,
      },
      tx,
    );
    logger.info("platform_credential.revoked", { organizationId, requestId: opts.requestId });
    return toStatus(row);
  });
  // Effective immediately in this process; other processes within the 10s row-cache TTL.
  invalidatePlatformCredentialCache(organizationId);
  return status;
}

export async function getPlatformCredentialStatus(organizationId: string): Promise<PlatformCredentialStatus> {
  if (!UUID.test(organizationId)) throw new ValidationError("organizationId must be a UUID");
  return toStatus(await findCurrentCredential(organizationId));
}
