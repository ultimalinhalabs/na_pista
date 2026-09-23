# F25A — Professionals Domain Decisions & Architecture Spike

> **Decision spike. No Professional/professional_services production code is implemented in this phase.**
> Every decision below is evidence-based (prior reports/ADRs, real code inspection) and closes exactly what
> F25 needs — nothing more. Full reasoning/alternatives live in
> [ADR-036](adr/ADR-036-professional-domain-model.md)..[ADR-038](adr/ADR-038-professional-scheduling-appointment-boundary.md);
> this document is the consolidated, implementation-facing summary plus the F25 contract.

## 1. Executive summary

F25 will implement **Professional** and its **N:M relationship to Service** (`professional_services`) —
deliberately not Scheduling, Availability, or Appointments (F26/F27). This phase closes every decision
required to build both without inventing business semantics mid-coding:

- **Professional is not a clone of Product or Service.** It has identity/contact semantics neither has, and
  no pricing/duration semantics at all.
- **Professional is not a Platform User.** No `userId`/`platformUserId` in this phase — an operational
  resource that may never sign in to anything, mirroring `Customer`'s own proven independence (ADR-025).
- **The Service relationship is a real N:M join table** (`professional_services`), never a foreign key on
  either side directly — structurally tenant-safe via the same two-composite-FK pattern `order_items` already
  proves.
- **Lifecycle** is the same `ACTIVE|ARCHIVED` toggle via `PATCH { status }` every recent module uses — no
  hard delete, no dedicated lifecycle endpoints, no `professionals.delete`.
- **Professional never contains anything Scheduling- or Appointment-shaped** — the four-way boundary
  (`Service=what, Professional=who, Scheduling=when, Appointment=the booking`) stays fully separate.

This document, together with ADR-036..038, is the package F25 implements directly from — see §17 "F25
implementation contract."

## 2. Professional model (ADR-036)

```
Professional {
  id
  organizationId
  name              -- required, 1-200 chars, no uniqueness
  description?      -- optional, plain text, ≤2000 chars
  phone?             -- optional, reuses Customer's exact validator
  email?             -- optional, reuses Customer's exact validator
  status             -- ACTIVE | ARCHIVED, default ACTIVE
  createdAt
  updatedAt
}
```
No `userId`/`platformUserId`, no `serviceId`, no scheduling/appointment fields. `phoneSchema`/`emailSchema` in
`customers/schemas.ts` need exporting (currently local `const`s) for F25 to import — the exact same minimal
step already taken for `priceSchema` (F23) and reused by Service (F24); not duplicating them.

## 3. Identity, name, contacts (ADR-036)

No uniqueness constraint on `name`, `phone`, or `email` — the same reasoning ADR-024 (Customer) and ADR-033
(Service) already establish: real businesses have coincidental or shared contact data, and rejecting it serves
no purpose. `phone`/`email` are informative only, **never** authentication identity — no OTP, no login, no
verification, no notifications tied to them in this phase.

## 4. Lifecycle (ADR-036)

`ACTIVE | ARCHIVED` only. No `ON_LEAVE`/`BUSY`/`AVAILABLE`/`VACATION`/`OFFLINE` — those are Scheduling/
Availability states (F26), never catalog membership. Archive/reactivate via `PATCH { status }` — no `DELETE`,
no dedicated `/archive`/`/reactivate` endpoints, matching F24's own just-established Service pattern (the
closest, most recent, most directly comparable precedent).

## 5. The Service relationship — `professional_services` (ADR-037, the central decision)

```
professional_services {
  id, organizationId, professionalId, serviceId, createdAt
}
```
A pure N:M join table — never `service.professionalId`, never `professional.serviceId`. Tenant-safe by
construction: two composite FKs, both keyed off the join row's own `organization_id`
(`(organization_id, professional_id) → professionals`, `(organization_id, service_id) → services`) — the same
mechanism `order_items` already proves for a two-sided reference. `UNIQUE(organization_id, professional_id,
service_id)` prevents duplicates and doubles as the lookup index. No `status` column on the join row — an
association exists or it doesn't.

**Requires one additive migration step on the *existing* `services` table**: a composite-FK-target unique
index `(organization_id, id)`, the same one-line addition F23 already made to `customers` the moment `orders`
first needed to reference it — not a Service redesign.

## 6. Association API and error semantics (ADR-037)

```
GET    /v1/organizations/:organizationId/professionals/:professionalId/services
POST   /v1/organizations/:organizationId/professionals/:professionalId/services/:serviceId
DELETE /v1/organizations/:organizationId/professionals/:professionalId/services/:serviceId
```
- Duplicate association → `409 CONFLICT` (not silent/idempotent).
- Nonexistent or cross-tenant Professional/Service → `404` (indistinguishable, never leaks existence).
- Associating an `ARCHIVED` Professional or `ARCHIVED` Service → `409` (new `PROFESSIONAL_ARCHIVED`/
  `SERVICE_ARCHIVED` error codes for F25 to define, mirroring `ProductArchivedError`'s shape).
- `DELETE` (disassociate) is always allowed regardless of either side's status, and is a real physical delete
  of the join row (no historical value of its own — the referenced Professional/Service rows are never
  themselves deleted).
- **Existing associations survive either side's archival** — archiving never removes a
  `professional_services` row; only *new* associations to an archived side are blocked.

## 7. Professional/Service existence independence

Both directions hold: a Professional may exist with zero associated Services (incremental onboarding); a
Service may exist with zero associated Professionals (unchanged from F24 — `services` itself is untouched by
this phase).

## 8. Authorization

`professionals.read` (all roles), `professionals.create`/`professionals.update` (OWNER/ADMIN/MANAGER,
identical — no tier distinction). **`professionals.update` also gates managing `professional_services`
associations** (create/remove) — no separate `professional_services.manage` permission, mirroring `Order`'s
own precedent of covering item-management under the same permission as its other mutations rather than
inventing a new tier. **No `professionals.delete`** — reasoned independently for Professional (not a blind
copy of Service): archive-only lifecycle, no demonstrated need for a stricter tier, consistent with
Inventory's/Orders'/Services' own more recent "no extra tier without a specific reason" posture.

## 9. Entitlement

`catalog.enabled`, unchanged. No `professionals.enabled`, no UL Platform change.

## 10. Audit

`professional.created`, `professional.updated`, `professional.archived`, `professional.reactivated` (exact
same 4-action pattern as Service, ADR-033/F24). Association events: `professional_service.created`,
`professional_service.removed` — both in the same transaction as the mutation they describe. No PII in
metadata (opaque `professionalId`/`serviceId` only, never name/phone/email/description).

## 11. Usage

`api_requests`, recorded on `professional.created` only — not on updates, not on association changes.
Justification: Professional's lifecycle is the same simple toggle as Product/Customer/Service (all "create
only"); association changes are catalog configuration, not a standalone business event worth metering on its
own (unlike Inventory movements or Order lifecycle transitions, which *are* the event each module exists to
track).

## 12. Tenant isolation

`organization_id NOT NULL` on both `professionals` and `professional_services`; a repository requiring a
resolved `TenantContext`; no `getProfessionalById(id)` without a tenant, ever — restating, not re-deciding,
the pattern every module since ADR-021 already proves.

## 13. API contract

```
GET    /v1/organizations/:organizationId/professionals              -- list (status/name-search/serviceId/limit)
GET    /v1/organizations/:organizationId/professionals/:professionalId
POST   /v1/organizations/:organizationId/professionals
PATCH  /v1/organizations/:organizationId/professionals/:professionalId   -- including status transitions
```
No `DELETE` on `/professionals/:id` itself (matches Service — lifecycle via `PATCH`). Association endpoints:
see §6. **Create input:** `{ name, description?, phone?, email? }` — never `id`/`organizationId`/`status`/
`createdAt`/`updatedAt`. **Update input:** same fields, all optional, plus `status`. **Response:** `{ id,
organizationId, name, description, phone, email, status, createdAt, updatedAt }`.

## 14. List/search

`status?`, `q?` (name search, ILIKE, matching every prior module), `serviceId?` (filter to Professionals
associated with a given Service — a cheap join against `professional_services`, the natural extension of
Product's own `categoryId` filter precedent), `limit? (1-100, default 50)`. No pagination beyond `limit`, no
full-text search engine, no reverse (`GET .../services/:id/professionals`) endpoint in F25's minimum — a
cheap additive extension if ever needed.

## 15. UI contract

**`na-pista-console` is the confirmed, official Na Pista UI** (F25A brief §24 explicitly confirms this,
resolving the tension F24's own report flagged). Future route: `/o/[organizationId]/professionals` (the real
Next.js App Router path convention already used by every existing page — not the brief's own `/app/o/...`
notation, which does not match how routes are actually written in this codebase). List (name, contacts,
associated-services count, status badge), create/edit form (name, description, phone, email), archive/
reactivate (a status-toggle button, matching Product/Service's own UI pattern), a way to view and manage a
Professional's associated Services (add/remove from their detail page). No calendar, no availability, no
booking UI — all F26/F27. Inherits `na-pista-console/DESIGN.md` verbatim, no new visual language. **Not
implemented in F25A** — F25's own responsibility, per this phase's own explicit scope.

## 16. Scheduling and Appointment boundaries (ADR-038)

Professional never contains scheduling-shaped fields (`workingHours`, `availability`, `blockedTimes`,
`vacation`, `break`, `calendar`, `appointmentSlots`) or appointment-shaped fields (`appointmentId`,
`currentAppointment`, `bookingStatus`). F26 reads `Professional`/`professional_services` unchanged, introduces
its own tables. F27 references `Professional`/`Service`/`Customer` together, snapshotting `professionalId`/
`professionalName` at booking time (mirroring `OrderItem`'s exact historical-integrity principle) and
validating the booked `(professionalId, serviceId)` pair exists in `professional_services` — neither requires
any change to `Professional`'s own schema.

## 17. F25 implementation contract

**Professional** (new table, tenant-scoped):
- `id uuid PK`, `organizationId uuid NOT NULL`, `name text NOT NULL`, `description text NULL`, `phone text
  NULL`, `email text NULL`, `status text NOT NULL DEFAULT 'ACTIVE'` (`ACTIVE|ARCHIVED`), `createdAt`,
  `updatedAt`.
- Indexes: `(organization_id, created_at)`, `(organization_id, status)` — matching every prior module's real
  query shapes. Composite-FK-target unique index `(organization_id, id)` — required now, since
  `professional_services` references it.

**`professional_services`** (new table, tenant-scoped):
- `id uuid PK`, `organizationId uuid NOT NULL`, `professionalId uuid NOT NULL`, `serviceId uuid NOT NULL`,
  `createdAt`.
- `UNIQUE(organization_id, professional_id, service_id)`.
- Composite FKs: `(organization_id, professional_id) → professionals`, `(organization_id, service_id) →
  services`, both `ON DELETE NO ACTION`.

**`services` table (existing, F24) needs one additive migration:** a composite-FK-target unique index
`(organization_id, id)` — no other change.

**API:** GET list/detail, POST create, PATCH update (§13); association sub-resource (§6).

**Authorization:** `professionals.read` (all), `professionals.create`/`professionals.update` (OWNER/ADMIN/
MANAGER) — the latter also gates association management. No `professionals.delete`.

**Entitlement:** `catalog.enabled`, unchanged.

**Audit:** `professional.created/updated/archived/reactivated`, `professional_service.created/removed`, all
transactionally consistent with their mutation.

**Usage:** `api_requests`, on `professional.created` only.

**Tenant isolation:** `organization_id NOT NULL` everywhere; repository requires `TenantContext`.

F25 does not need to make any further Professional-domain or relationship decision to begin implementation.

## 18. Deferred decisions

- **UI implementation** — contract defined (§15), not built; F25's own responsibility.
- **`platformUserId`** — additive, only if a real login requirement for Professionals is demonstrated
  (ADR-036/038).
- **Reverse association lookup** (`GET .../services/:id/professionals`) — cheap additive extension, not in
  F25's minimum.
- **Scheduling/Availability/working hours/buffers** — entirely F26's domain, untouched here.
- **Appointments/booking/self-booking** — entirely F27's domain, untouched here.
- **Personal-data/retention framework for Professional contact fields** — inherited from F18's still-open
  OD-22, same posture as Customer's, not resolved here (technical/legal question, not architectural).

## 19. Unresolved questions

None that block F25. Every question the brief posed (§35 self-review) is answered with evidence or explicit
reasoning in `docs/f25a-report.md`; nothing was force-closed without support.
