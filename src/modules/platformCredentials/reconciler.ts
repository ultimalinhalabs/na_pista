import { env } from "../../config/env.js";
import { callPlatform } from "../../platform/client.js";
import { decryptCredential } from "../../security/credentialCrypto.js";
import { getCredentialEncryptionKey } from "../../security/credentialKey.js";
import { logger } from "../../shared/logger.js";
import { findByProvisioningRequest, listPendingCredentials } from "./repository.js";
import {
  activateManagedCredential,
  revokeManagedCredentialLocally,
  storePendingManagedCredential,
  type IntrospectManagedCredential,
  type ProvisioningActor,
} from "./service.js";

/**
 * D2-B — the provisioning reconciler: Na Pista PULLS its managed Platform credentials server-to-server.
 * It authenticates to the Platform with ONE provisioner credential (PLATFORM_SERVICE / PROVISIONER,
 * scope `credential.provision`), which can only list and issue for open requests of NA_PISTA — the
 * Platform decides which organizations, from its own provisioning requests and commercial authority.
 *
 * Convergence rule (UL Platform docs/architecture/D2-B-ARCHITECTURE-REVISION.md §9.3):
 *  1. a local PENDING credential is CONFIRMED (never replaced by a new issuance);
 *  2. only when nothing is held locally for an open request is a new issuance asked for, with the
 *     request's current issue count (the Platform mints at most once per count);
 *  3. received secret → introspect → encrypt → store PENDING (durable) → confirm → activate.
 * Secrets never leave this function except to be encrypted or sent as a bearer to the Platform.
 */
const actor: ProvisioningActor = { type: "service", id: "system:provisioning-reconciler" };

interface OpenRequest {
  id: string;
  organizationId: string;
  application: string;
  status: "REQUESTED" | "ISSUED";
  issueCount: number;
  currentCredentialId: string | null;
}

export interface ReconcileResult {
  confirmed: number;
  issued: number;
  revokedLocally: number;
  skipped: number;
  failed: number;
}

export interface ReconcileOptions {
  provisioningCredential: string;
  requestId?: string;
  key?: () => Buffer;
  introspect?: IntrospectManagedCredential;
}

/** Confirms one held credential; activates it locally on success, retires it locally when the Platform refuses it. */
async function confirmHeld(organizationId: string, platformApiKeyId: string, provisioningRequestId: string, credential: string, opts: ReconcileOptions) {
  const res = await callPlatform("POST", `/service/credential-provisionings/${provisioningRequestId}/confirm`, { token: credential, requestId: opts.requestId });
  if (res.status === 200) {
    await activateManagedCredential(organizationId, platformApiKeyId, { actor, requestId: opts.requestId });
    return "confirmed" as const;
  }
  // The Platform has looked at this exact credential and refused it for good: retire the local copy.
  // (401 = revoked, or its confirmation window passed; 409 = no longer the request's current credential;
  //  403 = the commercial authorization is gone; 404 = not this credential's request.)
  if ([401, 403, 404, 409].includes(res.status)) {
    await revokeManagedCredentialLocally(organizationId, platformApiKeyId, { actor, requestId: opts.requestId, reason: `confirm_refused:${res.error?.code ?? res.status}` });
    return "revoked" as const;
  }
  return "failed" as const; // transient (5xx / unexpected): keep PENDING, retry next cycle
}

export async function reconcileOnce(opts: ReconcileOptions): Promise<ReconcileResult> {
  const result: ReconcileResult = { confirmed: 0, issued: 0, revokedLocally: 0, skipped: 0, failed: 0 };
  const key = opts.key ?? getCredentialEncryptionKey;

  // 1. Confirm everything already held as PENDING (covers "stored, then the response was lost" and "confirmed, then the response was lost").
  for (const row of await listPendingCredentials()) {
    try {
      const credential = decryptCredential(row.encryptedCredential, row.organizationId, key());
      const outcome = await confirmHeld(row.organizationId, row.platformApiKeyId, row.provisioningRequestId!, credential, opts);
      if (outcome === "confirmed") result.confirmed++;
      else if (outcome === "revoked") result.revokedLocally++;
      else result.failed++;
    } catch (error) {
      result.failed++;
      logger.warn("platform_credential.reconcile_failed", { organizationId: row.organizationId, stage: "confirm_pending", error: error instanceof Error ? error.name : "unknown", requestId: opts.requestId });
    }
  }

  // 2. Open requests of this application (the Platform derives the application from the provisioner credential).
  const list = await callPlatform<OpenRequest[]>("GET", "/service/credential-provisionings", { token: opts.provisioningCredential, requestId: opts.requestId });
  if (list.status !== 200 || !list.data) {
    logger.warn("platform_credential.reconcile_failed", { stage: "list", status: list.status, code: list.error?.code, requestId: opts.requestId });
    result.failed++;
    return result;
  }

  for (const request of list.data) {
    try {
      const held = await findByProvisioningRequest(request.organizationId, request.id);
      if (held.some((r) => r.status === "PENDING" || r.status === "ACTIVE")) {
        result.skipped++; // already held (step 1 is the one that confirms it)
        continue;
      }

      const issued = await callPlatform<{ credential: { id: string; token: string } }>("POST", `/service/credential-provisionings/${request.id}/issue`, {
        token: opts.provisioningCredential,
        body: { expectedIssueCount: request.issueCount },
        requestId: opts.requestId,
      });
      if (issued.status !== 201 || !issued.data) {
        // 409 = someone else issued for this count / not open anymore; 403 = not authorized now. Next cycle re-reads.
        result.skipped++;
        logger.info("platform_credential.issue_not_done", { organizationId: request.organizationId, status: issued.status, code: issued.error?.code, requestId: opts.requestId });
        continue;
      }
      result.issued++;
      const credential = issued.data.credential.token;

      const stored = await storePendingManagedCredential(
        { organizationId: request.organizationId, provisioningRequestId: request.id, credential },
        { actor, requestId: opts.requestId, introspect: opts.introspect, key: opts.key },
      );
      const outcome = await confirmHeld(request.organizationId, stored.platformApiKeyId, request.id, credential, opts);
      if (outcome === "confirmed") result.confirmed++;
      else if (outcome === "revoked") result.revokedLocally++;
      else result.failed++;
    } catch (error) {
      // Not stored → nothing held → the next cycle asks for a new issuance (the Platform supersedes the unconfirmed one).
      result.failed++;
      logger.warn("platform_credential.reconcile_failed", { organizationId: request.organizationId, stage: "issue", error: error instanceof Error ? error.name : "unknown", requestId: opts.requestId });
    }
  }
  return result;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/** Starts the periodic reconciler when a provisioner credential is configured. One cycle at a time per process. */
export function startProvisioningReconciler(): boolean {
  const provisioningCredential = env.NA_PISTA_PROVISIONING_CREDENTIAL;
  if (!provisioningCredential || timer) return false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileOnce({ provisioningCredential, requestId: "reconciler" });
      if (result.issued || result.confirmed || result.revokedLocally || result.failed) logger.info("platform_credential.reconciled", { ...result });
    } catch (error) {
      logger.warn("platform_credential.reconcile_failed", { stage: "cycle", error: error instanceof Error ? error.name : "unknown" });
    } finally {
      running = false;
    }
  };
  timer = setInterval(() => void tick(), env.NA_PISTA_RECONCILE_INTERVAL_MS);
  timer.unref();
  void tick();
  return true;
}

export function stopProvisioningReconciler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
