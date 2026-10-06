# ADR-056 — Platform Credential Status Contract

- **Estado:** Accepted — implemented (F30)
- **Data:** 2026-10-01
- **Phase:** F30

## Context

F29A persists each organization's Platform credential (encrypted) and already has a safe projection,
`getPlatformCredentialStatus()` → `{ configured, status, createdAt, updatedAt, revokedAt }`, with no route.

## Decision

`GET /v1/organizations/:organizationId/platform-credential` — a singular sub-resource, like `/settings`.

- **Response:** exactly F29A's `PlatformCredentialStatus`:
  `{ "configured": boolean, "status": "ACTIVE" | "REVOKED" | null, "createdAt", "updatedAt", "revokedAt" }`.
  `configured` means "a credential record exists"; `status` says whether it is usable. Never the credential, the
  ciphertext, the Platform key id, an Authorization header or any key material.
- **Authorization:** new permission **`integrations.read`**, OWNER and ADMIN (mirrors the Platform's `api_key.read`).
  **Human only** — no Platform scope exists for it.
- **Not behind the `catalog.enabled` gate.** The gate itself calls the Platform *with this credential*; if the
  credential is missing or revoked the gate fails `503`, which would hide the status exactly when it is needed. Tenant
  resolution (membership) and `integrations.read` still apply.
- Reads the database only — never calls the Platform, never decrypts.
- Reports the **persisted** state. The non-production in-memory test override (F29A) is not a persisted credential and
  is not reported.
- Read-only. Provisioning/rotation/revocation stay operator actions (`npm run credentials:provision`, F29A §7); exposing
  them over HTTP would need a Platform-side issuance flow that does not exist.

## Alternatives considered

- Route under `/integrations/platform-credential`: introduces an `integrations` namespace with one member. Rejected.
- Behind the capability gate for uniformity: makes the endpoint useless for diagnosis. Rejected.

## Compatibility impact

New endpoint, new permission.

## Migration impact

None.

## Testing impact

Configured (ACTIVE), revoked, missing, tenant isolation, OWNER/ADMIN allowed, MANAGER/STAFF/service denied, works
when the credential is missing (no 503), no secret/ciphertext in the response or logs.
