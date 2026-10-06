# Professional Management API (F25)

Base: `{NA_PISTA_API_URL}/v1`. Same envelope, versioning, and request pipeline as
[`products-api.md`](products-api.md): **1.** authenticate → **2.** resolve tenant → **3.** permission/scope →
**4.** `catalog.enabled` entitlement (reused unchanged — no `professionals.enabled` invented, ADR-036) → **5.**
business logic → **6.** persist tenant-scoped → **7.** audit → **8.** usage.

## Model note (ADR-036/037/038)
`Professional` is deliberately **not** a Product/Service clone and **not** a Platform User — no `userId`, no
`customerId`/`serviceId`/`appointmentId`/`scheduleId`, no calendar/availability/working-hours/booking fields.
The relationship to `Service` is a real N:M join (`professional_services`) — never a foreign key on either
side directly.

## `POST /organizations/:organizationId/professionals`
- **Permission:** `professionals.create` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Entitlement:** `catalog.enabled`.
- **Request:** `{ "name": string (1-200), "description"?: string (≤2000), "phone"?: string, "email"?: string
  (≤320) }` — `.strict()`: unknown fields rejected, including `id`/`organizationId`/`status`/`createdAt`/
  `updatedAt`/`userId`/`serviceId`/`customerId`/`appointmentId`/`scheduleId`/any calendar-, availability-, or
  booking-shaped field. `phone`/`email` reuse `Customer`'s exact validators — never authentication identity.
- **Response `201`:** `{ id, organizationId, name, description, phone, email, status: "ACTIVE", createdAt,
  updatedAt }`.
- **Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`/`ENTITLEMENT_REQUIRED`,
  `503 UPSTREAM_UNAVAILABLE`.

## `GET /organizations/:organizationId/professionals`
- **Permission:** `professionals.read` (all roles) · **Scope:** `catalog.read`.
- **Query:** `status?: ACTIVE|ARCHIVED`, `q?: string` (name, case-insensitive substring), `serviceId?: uuid`
  (filter to Professionals associated with that Service, via `professional_services`).
- **Pagination & sorting (F30, ADR-051/052):** `page` (default 1), `pageSize` (default 50, max 100; `limit` = deprecated alias), `sort` ∈ {`createdAt`, `name`} + `order=asc|desc`. The response adds `pagination: { page, pageSize, total, totalPages }` beside `data` — see [pagination.md](pagination.md).
- **Response `200`:** `Professional[]`, newest first.

## `GET /organizations/:organizationId/professionals/:professionalId`
- Same auth/entitlement as list. **`404 NOT_FOUND`** if it doesn't exist *or* belongs to another organization.
  Returns the resource **regardless of `status`** — an archived Professional is still readable by id.

## `PATCH /organizations/:organizationId/professionals/:professionalId`
- **Permission:** `professionals.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request (all optional, unknown fields rejected):** `{ name?, description?: string|null, phone?:
  string|null, email?: string|null, status?: "ACTIVE"|"ARCHIVED" }`.
- **This is also the lifecycle endpoint** (ADR-036 §19): `{ "status": "ARCHIVED" }` archives,
  `{ "status": "ACTIVE" }` reactivates — no `DELETE`, no dedicated lifecycle endpoints, matching Service's own
  established pattern.

## Service associations (`professional_services`, ADR-037)

### `GET /organizations/:organizationId/professionals/:professionalId/services`
- **Permission:** `professionals.read` · **Scope:** `catalog.read`.
- **Response `200`:** the Services this Professional is associated with, joined for display —
  `[{ id, name, durationMinutes, price, status, associatedAt }]`, newest association first.
- `404 NOT_FOUND` if the Professional doesn't exist in this tenant.

### `POST /organizations/:organizationId/professionals/:professionalId/services/:serviceId`
Creates the association. **Permission:** `professionals.update` (no separate `professional_services.manage`
tier) · **Scope:** `catalog.write`.
- **Response `201`:** `{ id, organizationId, professionalId, serviceId, createdAt }`.
- **Errors:**
  - `404 NOT_FOUND` — the Professional or the Service doesn't exist in this tenant (including cross-tenant —
    indistinguishable from nonexistent, never leaks existence).
  - `409 PROFESSIONAL_ARCHIVED` — the Professional is archived; a new capability should not be configured
    onto a resource being wound down.
  - `409 SERVICE_ARCHIVED` — the Service is archived.
  - `409 CONFLICT` — this exact association already exists (the database's own
    `UNIQUE(organization_id, professional_id, service_id)` constraint, translated — never a raw Postgres
    error, never a silent second row).

### `DELETE /organizations/:organizationId/professionals/:professionalId/services/:serviceId`
Removes the association — a real physical delete of the join row (the one physical delete in this domain; the
Professional and Service rows themselves are never touched). **Always allowed regardless of either side's
`ARCHIVED` status** — narrowing what exists is never a new capability.
- **Response `200`:** `{ removed: true }`.
- `404 NOT_FOUND` if the Professional doesn't exist, or if no such association exists (a second `DELETE`
  attempt on an already-removed association also `404`s — never a silent no-op, never a double-effect).

## Entitlement
Gated by `catalog.enabled` — the same key every prior module uses. No new Platform entitlement invented.

## Authorization
`professionals.read` (all roles), `professionals.create`/`professionals.update` (OWNER/ADMIN/MANAGER,
identical). `professionals.update` also gates association management (create/remove) — no separate
`professional_services.manage` permission, mirroring `Order`'s own item-management precedent. **No
`professionals.delete`** — reasoned independently for Professional (ADR-036 §8), not copied from Service.

## Tenant isolation
`organization_id NOT NULL` on both `professionals` and `professional_services`. The association is tenant-safe
**structurally**, not just at the application layer: two composite foreign keys, both keyed off
`professional_services.organization_id` — the same mechanism `order_items` already proves for a two-sided
reference — make a cross-tenant association physically impossible to insert, confirmed directly against real
Postgres (`tests/integration/professionals.test.ts`).

## Audit
`professional.created`, `professional.updated`, `professional.archived`, `professional.reactivated` (the
service layer picks `archived`/`reactivated` specifically when `status` transitions direction, `updated`
otherwise — same logic Service already established). `professional_service.created`,
`professional_service.removed` — both in the same transaction as the mutation they describe. No PII in
metadata — opaque `professionalId`/`serviceId` only, never name/phone/email/description.

## Usage
`api_requests`, recorded on `professional.created` only — not on updates, not on association changes, matching
Product/Customer/Service's established "create only" convention.

## Examples

```
POST /v1/organizations/{orgId}/professionals
Authorization: Bearer <token>

{ "name": "João Silva", "description": "Barbeiro sénior", "phone": "+244923456789" }

201
{ "data": { "id": "...", "organizationId": "...", "name": "João Silva",
            "description": "Barbeiro sénior", "phone": "+244923456789", "email": null,
            "status": "ACTIVE", "createdAt": "...", "updatedAt": "..." } }
```

```
POST /v1/organizations/{orgId}/professionals/{professionalId}/services/{serviceId}

409
{ "error": { "code": "SERVICE_ARCHIVED", "message": "Service \"...\" is archived; cannot create a new professional association" } }
```

```
GET /v1/organizations/{orgId}/professionals/{professionalId}/services

200
{ "data": [ { "id": "...", "name": "Corte Masculino", "durationMinutes": 45, "price": "3500.00",
              "status": "ACTIVE", "associatedAt": "..." } ] }
```

## Not built in this slice (F25 brief §42, ADR-038)
Scheduling, Availability, working hours, calendars, vacation, breaks, time slots, Appointments, Booking,
self-booking, notifications, commissions, payroll, ratings/reviews. A reverse association lookup
(`GET .../services/:id/professionals`) is not built either — a cheap additive extension if ever needed.
