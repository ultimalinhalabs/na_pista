# ADR-037 — Professional-Service Relationship (`professional_services`)

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F25A (spike)
- **Closes:** the N:M relationship ADR-035 (F24A) named and deferred

## Context
ADR-035 already decided the relationship shape conceptually (`professional_services`, composite-FK both
sides, additive, not built in F24) and explicitly ruled out `service.professionalId`/
`professional.serviceId`. F25A must now close the concrete table shape, tenant-safety mechanism, and
association API semantics — the central decision this phase exists to make (F25A brief §10).

## Decision

**A pure N:M join table, never a foreign key on either `Professional` or `Service` directly:**
```
professional_services {
  id                -- uuid PK, surrogate — matches every other table in this codebase (including
                        order_items, which has an equally-valid natural composite key candidate and still
                        gets its own surrogate id; consistency over marginal storage savings)
  organizationId
  professionalId
  serviceId
  createdAt         -- when the association was made; no updatedAt — the row is never mutated, only
                        created or removed (a pure join has no field to "update")
}
```

**Tenant safety — structural, not just application-level (F25A brief §11):** two composite foreign keys, both
keyed off `professional_services.organization_id` — the exact mechanism `order_items` already proves for
referencing two different tables (`orders`, `products`) safely:
```
(organization_id, professional_id) -> professionals(organization_id, id)
(organization_id, service_id)      -> services(organization_id, id)
```
Because both FKs constrain against the **same** `organization_id` column on the join row, a
`professional_services` row can only ever reference a Professional and a Service that both belong to that
exact organization — a Professional from Organization A can never be associated with a Service from
Organization B, enforced by Postgres itself. This requires a composite-FK-target unique index
`(organization_id, id)` on **both** `professionals` and `services` — `services` does not have one yet
(F24A/ADR-033 deliberately did not add one speculatively, since nothing referenced it by FK at the time); F25
adds it the same way F23 added `customers_org_id_unique` the moment Order first needed one — purely additive,
not a Service redesign.

**Duplicate prevention:** `UNIQUE(organization_id, professional_id, service_id)` on `professional_services` —
the same unique index also serves the "list this Professional's Services" query efficiently (a query filtering
on `(organization_id, professional_id)` uses the index's leading columns; no separate index is needed).

**No `status` column on the join row.** The association either exists or it doesn't — no "temporarily
disabled without removing" state is demonstrated as necessary (F25A brief §10: "não adicionar campos sem
necessidade"). If a real requirement for a soft-disable state appears later, it is an additive column.

**Association API (F25A brief §12, not implemented now):**
```
GET    /v1/organizations/:organizationId/professionals/:professionalId/services   -- this Professional's Services
POST   /v1/organizations/:organizationId/professionals/:professionalId/services/:serviceId    -- associate
DELETE /v1/organizations/:organizationId/professionals/:professionalId/services/:serviceId    -- disassociate
```
- **Duplicate association attempt → `409 CONFLICT`**, not silent success/idempotency — reusing the existing
  `isUniqueViolationError`/`ConflictError` machinery every prior module already carries but rarely needed
  (`Customer`'s own ADR-024 explicitly kept this "preserved and ready" without a real use case until now).
  Matches the established "explicit error over silent success" posture (e.g., `Order`'s own double-confirm
  behavior, ADR-032) rather than inventing an idempotent-create convention this codebase has never used.
- **Nonexistent Professional or Service → `404`.** **Cross-tenant Professional or Service → `404`** too,
  indistinguishable from nonexistent — never leaks cross-tenant existence, matching every module's posture.
- **Associating an `ARCHIVED` Professional or `ARCHIVED` Service → `409`** (new, dedicated error codes —
  `PROFESSIONAL_ARCHIVED`/`SERVICE_ARCHIVED` — for F25 to define, mirroring `ProductArchivedError`'s exact
  shape and reasoning from ADR-028/F23). A new capability should not be configured onto a resource that is
  being wound down.
- **Removing (`DELETE`) an association is always allowed regardless of either side's status** — disassociating
  is never a "new capability," it only narrows what already exists.
- **The join row itself is physically deleted on disassociation** — the same reasoning `OrderItem`'s DRAFT-only
  physical delete already established (ADR-032): a pure association has no historical value of its own once
  removed; the Professional and Service rows it referenced are never themselves deleted, so nothing
  historical is lost. `ON DELETE NO ACTION` on both FKs (the same default every other composite FK in this
  codebase already uses) — moot in practice, since Professional/Service rows are never physically deleted
  either.

**Existing associations survive either side's archival (F25A brief §13/§14):** archiving a Professional or a
Service **never** removes its existing `professional_services` rows — matches the universal "archive is not
delete" posture. A `Professional ACTIVE` associated with a now-`ARCHIVED` `Service` keeps that association
(useful even historically — "this professional used to perform this now-discontinued service"); only **new**
associations to an archived side are blocked (above). This is deliberately narrower than any future
Appointment-booking rule (whether an archived Service can be booked) — F25A does not duplicate or anticipate
that rule; it only decides what the *catalog relationship* itself does.

**Professional without any Service, and Service without any Professional, are both valid states** (F25A brief
§15/§16) — a Professional can be created before the catalog is configured (incremental onboarding); `Service`
already permits existing without a Professional (F24, unchanged, untouched by this phase).

## Alternatives

**`service.professionalId` (single professional per service)** — rejected outright by F24A/ADR-035 already;
restated here as still rejected, no new reasoning changes it.

**`professional.serviceIds` (an array/JSON column)** — rejected: not queryable/joinable the way a real
relational table is, cannot enforce tenant-safety structurally, cannot be indexed for the reverse lookup, and
contradicts the relational modeling every other multi-valued relationship in this codebase uses.

**A `status` column on `professional_services` (e.g., `ACTIVE`/`SUSPENDED`)** — rejected; no demonstrated
need, exactly the speculative field the brief warns against.

**Idempotent `POST` (duplicate association silently succeeds)** — considered, rejected in favor of explicit
`409 CONFLICT`, matching this codebase's consistent preference for explicit errors over silent no-ops.

**`ON DELETE CASCADE` on the composite FKs** — rejected: nothing in this domain ever physically deletes a
Professional or Service row, so cascade behavior is never exercised; specifying it would imply a deletion
pathway that does not exist, inviting confusion later.

## Consequences
- (+) Tenant-unsafe associations are structurally impossible, not just application-checked — the same
  guarantee `order_items` already proves for a two-sided composite-FK join.
- (+) F25's implementation has zero ambiguity left: table shape, constraints, API routes, and every error
  code/condition are specified.
- (−) `services` requires one additive migration step (the composite-FK-target unique index) before
  `professional_services` can be built — a small, well-precedented, one-line addition, not a redesign.

## Future extension path
A `serviceId` reverse-lookup endpoint (`GET .../services/:serviceId/professionals`) is a cheap additive
query against the same table/index, added the moment a real UI need for it appears — not built now (F25A
brief §23's own list/search minimum does not require it).
