# ADR-055 — Audit Read Contract

- **Estado:** Accepted — implemented (F30)
- **Data:** 2026-10-01
- **Phase:** F30

## Context

Na Pista writes a business audit trail (`audit_events`, ADR-023) in the same transaction as every relevant mutation,
but exposes no way to read it.

## Decision

`GET /v1/organizations/:organizationId/audit-events` — read-only, tenant-scoped.

- **Authorization:** new Na Pista permission **`audit.read`**, granted to **OWNER and ADMIN** only — mirroring the UL
  Platform's own `audit.read` (OWNER+ADMIN). Added to the existing role map (`authorization/permissions.ts`); no new
  authorization mechanism. **Human only:** service credentials receive `403` — the Platform defines no scope for
  reading audit data, and Na Pista must not invent Platform scopes.
- Behind the same `catalog.enabled` gate as every other Na Pista resource.
- **Fields:** `id, action, actorType (user|service), actorId, resourceType, resourceId, requestId, metadata, createdAt`.
- **Metadata safety:** metadata is written only by Na Pista code and is already secret-free (F29A tests). As defence in
  depth, the read path redacts any object key matching `/secret|token|password|passphrase|credential|ciphertext|encrypted|authorization|private.?key/i`
  (value → `"[REDACTED]"`), recursively. Tests assert no secret appears for every action present.
- **Filters:** `action`, `actorType`, `resourceType`, `resourceId`, `from`, `to` (ISO-8601 date-times, inclusive
  `from`, exclusive `to`). Each is an equality / range predicate on an indexed column — no JSON querying.
- **Order:** `createdAt desc, id desc`. **Pagination:** ADR-051 (default 50, max 100).
- **Stable traversal of a growing log:** new events always have `createdAt = now`. A client that pins `to` to the
  time of its first request sees a fixed set, so offset pages cannot shift. Documented in `docs/api/audit.md`.

## Alternatives considered

- Cursor pagination (as the Platform's audit log): stable without pinning, but a second pagination model in one API;
  pinning `to` gives the same guarantee with the shared contract. Rejected for now.
- Exposing audit to service credentials with `catalog.read`: would let any integration key read who did what across
  the organization — broader than the Platform grants humans below ADMIN. Rejected.

## Compatibility impact

New endpoint, new permission. MANAGER/STAFF get `403` (they never had audit access).

## Migration impact

None; uses existing indexes `(organization_id, created_at)` and `(organization_id, resource_type, resource_id)`.

## Testing impact

Pagination, each filter, combined filters, tenant isolation (rows and totals), OWNER/ADMIN allowed, MANAGER/STAFF/
service denied, redaction, no secret in any response.
