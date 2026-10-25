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
3. **Transition:** `NA_PISTA_LEGACY_CATALOG_SCOPES=accept` (default) still accepts `catalog.read` for the read scopes
   and `catalog.write` for the write scopes — NA_PISTA keys only, never read-for-write — and logs
   `service.legacy_scope_used` once per key and scope per process. `refuse` is the strict mode.

## Consequences

- QD/FOI keys stop reaching Na Pista at all. An application that must read Na Pista uses a NA_PISTA key with the
  minimum scopes, created by the OWNER.
- Removing the legacy fallback needs: the inventory (`GET /v1/platform/credentials/inventory`) showing which NA_PISTA keys
  hold only `catalog.*`, their owners re-issuing them, and no `service.legacy_scope_used` over an agreed period —
  absence of logs over a short window is not proof of disuse.
- Human permissions are unchanged.
