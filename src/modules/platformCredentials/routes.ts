import { Router } from "express";
import { requireHumanPermission } from "../../middleware/requireAuthorized.js";
import { validateUuidParams } from "../../shared/params.js";
import { ok } from "../../shared/response.js";
import { requireTenantContext } from "../../tenancy/tenantContext.js";
import { getPlatformCredentialStatus } from "./service.js";

export const platformCredentialsRouter = Router();
validateUuidParams(platformCredentialsRouter);

/**
 * ADR-056: safe status of the organization's persisted Platform credential
 * — never the credential, ciphertext, key id or any key material.
 *
 * Deliberately NOT behind `requireCapability("catalog.enabled")`: that gate
 * calls the Platform WITH this credential, so a missing/revoked credential
 * would turn this diagnostic into a 503 exactly when it is needed. Tenant
 * membership and `integrations.read` (OWNER/ADMIN, humans only) still apply.
 * Reads the database only; never calls the Platform, never decrypts.
 */
platformCredentialsRouter.get(
  "/organizations/:organizationId/platform-credential",
  requireTenantContext(),
  requireHumanPermission("integrations.read"),
  async (req, res, next) => {
    try {
      ok(res, await getPlatformCredentialStatus(req.tenant!.organizationId));
    } catch (error) {
      next(error);
    }
  },
);
