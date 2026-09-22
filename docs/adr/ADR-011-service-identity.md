# ADR-011 — Na Pista Service Identity

- **Estado:** Accepted
- **Data:** 2026-09-22
- **Closes:** OD-11

## Context
Na Pista needs to call UL Platform (read entitlements, write usage, publish events) as itself, on behalf of
one specific organization at a time — never as a human, never as the whole platform at once (CLAUDE.md §6:
human and service authentication are different concerns). Two shapes exist in the Platform's schema today:
an organization-scoped API key (`organizationId` set) and a platform-level one (`organizationId = null`).

## Decision
One organization-scoped `NA_PISTA` API key per Organization, held by Na Pista (`src/platform/serviceAuth.ts`
in the spike; a real secret store in production). Two credential classes per organization, never merged:
"platform-facing" (`usage.write`, `event.publish` — Na Pista's own outbound calls) and "integration"
(`catalog.read`/`catalog.write`/`customer.read` — what a tenant's own client, or another UL application, uses
to call *into* Na Pista).

## Alternatives
A single platform-level (`organizationId = null`) credential acting on behalf of any organization —
structurally rejected by every service-scoped middleware in the Platform today (`requireServiceOrganizationMatch`,
`requireEntitlementAccess`: a `null` organizationId can never equal a URL's real UUID). Would require a real
Platform change — recorded, not built (`platform-changes-required.md` §PC-1).

## Consequences
- (+) A compromised credential's blast radius is exactly one organization.
- (+) No Platform change needed to close this decision.
- (−) N organizations = N secrets Na Pista must provision, store securely, and rotate/revoke independently —
  this spike's in-memory registry is not that; a real secret store is required before production.

See `docs/decisions.md` §OD-11 for the full runtime evidence.
