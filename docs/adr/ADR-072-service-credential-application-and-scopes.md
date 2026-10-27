# ADR-072 — Service credentials: NA_PISTA keys only, per-resource scopes for personal data

- **Estado:** Accepted — implemented locally (branch `feature/service-credential-application-and-scopes`; not deployed)
- **Data:** 2026-10-23
- **Origem:** credentials audit (`projeto_ul/docs/architecture/NA-PISTA-CREDENTIALS-AUDIT-2026-10-23.md`); UL Platform migration 0032

## Context

`requireTenantContext` compared only the key's organization; every read required `catalog.read`, every write
`catalog.write`. UL lets QUALE_A_DICA and FOI keys hold `catalog.read`, so such a key of an organization that also has
Na Pista read its customers, orders and stock (demonstrated end to end against a local UL Platform). `customer.read`
existed on UL but was never required. `docs/authorization.md` §3.2 had planned exactly the separation that the code
had lost.

## Decision

1. **Application:** a service key is accepted only when the Platform's introspection says `application = NA_PISTA`
   (UL semantics: an ORGANIZATION key is the organization's integration *with* that application). Other applications
   get 403 `FORBIDDEN`. In memory, from the introspection already done — no extra call.
2. **Scopes:** customers → `customer.read` / `customer.write`; orders → `order.read` / `order.write`; appointments →
   `appointment.read` / `appointment.write`. Everything else stays on `catalog.*`, including free bookable slots (no
   personal data). One source: `src/authorization/serviceScopes.ts`, used by the routes and the OpenAPI contract.
   Create/manage are not split yet: no consumer needs it; split when the first external interface does.
3. **Strict by default:** `NA_PISTA_LEGACY_CATALOG_SCOPES=refuse`. The production inventory (2026-10-26, 24 keys)
   found no key of another application and no live key relying on `catalog.*` for personal data: the 11 active NA_PISTA
   organization keys all belong to test organizations without NA_PISTA access, which UL already refuses at runtime.
   `accept` remains an emergency switch: it admits `catalog.read` for the read scopes and `catalog.write` for the
   write scopes (NA_PISTA keys only, never read-for-write) and logs `service.legacy_scope_used` once per key and scope.

## Consequences

- QD/FOI keys stop reaching Na Pista at all. An application that must read Na Pista uses a NA_PISTA key with the
  minimum scopes, created by the OWNER.
- The emergency switch can be removed from the code once the strict mode has run in production without incident.
  Before any new integration key is issued, check the inventory (`GET /v1/platform/credentials/inventory`).
- Human permissions are unchanged.
