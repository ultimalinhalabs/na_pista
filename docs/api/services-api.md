# Service Management API (F24)

Base: `{NA_PISTA_API_URL}/v1`. Same envelope, versioning, and request pipeline as
[`products-api.md`](products-api.md): **1.** authenticate → **2.** resolve tenant → **3.** permission/scope →
**4.** `catalog.enabled` entitlement (reused unchanged — no `services.enabled` invented, F24A/ADR-033) → **5.**
business logic → **6.** persist tenant-scoped → **7.** audit → **8.** usage.

## Model note (F24A/ADR-033/034)
`Service` is deliberately **not** a Product clone — no `categoryId`, no `unit`, and critically no reference at
all to Customer/Professional/Appointment/Scheduling (those belong to F25-F27, none built yet). Its one field
Product never had is `durationMinutes` — a plain positive integer, not a decimal string (ADR-034).

## `POST /organizations/:organizationId/services`
- **Permission:** `services.create` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Entitlement:** `catalog.enabled`.
- **Request:** `{ "name": string (1-200), "description"?: string (≤2000), "durationMinutes": integer (> 0),
  "price"?: number|string }` — `.strict()`: unknown fields rejected, including `id`/`organizationId`/
  `status`/`currency`/`createdAt`/`updatedAt`/`categoryId`/`professionalId`/`customerId`/anything
  scheduling-shaped.
  - `durationMinutes` is a **plain JSON number**, never a decimal string (unlike `price`/`quantity`) — a
    decimal (`45.5`), a numeric string (`"60"`), `NaN`, or `Infinity` are all rejected (ADR-034).
  - `price` accepts a JSON number or decimal string, normalized to a fixed 2-decimal string (ADR-029);
    omit it to leave the Service unpriced (`null`).
- **Response `201`:** `{ id, organizationId, name, description, durationMinutes, price, status: "ACTIVE",
  createdAt, updatedAt }`. `price` is `null` when unset. No `currency` field (F24A/ADR-030, extended).
- **Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`/`ENTITLEMENT_REQUIRED`,
  `503 UPSTREAM_UNAVAILABLE`.

## `GET /organizations/:organizationId/services`
- **Permission:** `services.read` (all roles) · **Scope:** `catalog.read`.
- **Query:** `status?: ACTIVE|ARCHIVED`, `q?: string` (name, case-insensitive substring), `limit?: 1-100
  (default 50)`.
- **Response `200`:** `Service[]`, newest first.

## `GET /organizations/:organizationId/services/:serviceId`
- Same auth/entitlement as list. **`404 NOT_FOUND`** if it doesn't exist *or* belongs to another organization
  — indistinguishable, never `403` for that case. Returns the resource **regardless of `status`** — an
  archived Service is still readable by id (F24A/ADR-033 §8).

## `PATCH /organizations/:organizationId/services/:serviceId`
- **Permission:** `services.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request (all optional, unknown fields rejected):** `{ name?, description?: string|null, durationMinutes?,
  price?: number|string|null, status?: "ACTIVE"|"ARCHIVED" }`. `price: null` explicitly clears it back to
  "not yet priced" — distinct from `0` ("deliberately free").
- `id`, `organizationId`, `createdAt`, `updatedAt` are never accepted from the client.
- **This is also the lifecycle endpoint** (F24A/ADR-033 §19): `{ "status": "ARCHIVED" }` archives,
  `{ "status": "ACTIVE" }` reactivates. **No `DELETE`, no dedicated `/archive` or `/reactivate` endpoints** —
  a deliberate choice reusing Product/Customer's proven `PATCH`-status mechanism rather than Order's dedicated
  lifecycle-endpoint style, since Service's lifecycle is the same simple two-state toggle Product/Customer
  already have, not a multi-state machine.

## Entitlement
Gated by `catalog.enabled` — the same key every prior module uses (ADR-022). No new Platform entitlement
invented, no UL Platform change (F24A/ADR-033 §15, F24 brief §7/§29's explicit instruction).

## Authorization
`services.read` (all roles), `services.create`/`services.update` (OWNER/ADMIN/MANAGER, identical — no tier
distinction between the three). **No `services.delete`** — a deliberate departure from Product/Customer's own
OWNER/ADMIN-only archive-permission tier (F24A found no Service-specific reason to restrict archiving more
tightly than any other write; see ADR-033 §14 for the full reasoning).

## Tenant isolation
Identical posture to every prior module: `organization_id NOT NULL`, a repository that cannot run without a
resolved `TenantContext`, and every cross-organization access attempt resolves to `403` (no membership/wrong
credential) or `404` (real membership, wrong resource) — never the other organization's data.

## Uniqueness
No uniqueness constraint on `name` (F24A/ADR-033 §6) — two Services in the same Organization may legitimately
share a name, the same reasoning ADR-024 already applied to `Customer.name`.

## Audit
`service.created`, `service.updated`, `service.archived`, `service.reactivated` — same transaction as the
mutation. `archived`/`reactivated` are used specifically when a `PATCH`'s `status` field is the one that
actually transitions direction; any other field edit (with or without a no-op `status` value) logs
`service.updated`. No PII in metadata — opaque ids/field-name lists only.

## Usage
`api_requests` meter, recorded on `service.created` only (not on every update) — matching Product/Customer's
established "record on create only" convention (F24A/ADR-033 §17), since Service's lifecycle is a simple
two-state toggle, not a multi-stage process like Order's or a per-event ledger like Inventory's.

## Examples

```
POST /v1/organizations/{orgId}/services
Authorization: Bearer <token>

{ "name": "Corte Masculino", "description": "Corte tradicional masculino", "durationMinutes": 45,
  "price": "3500.00" }

201
{ "data": { "id": "...", "organizationId": "...", "name": "Corte Masculino",
            "description": "Corte tradicional masculino", "durationMinutes": 45, "price": "3500.00",
            "status": "ACTIVE", "createdAt": "...", "updatedAt": "..." } }
```

```
PATCH /v1/organizations/{orgId}/services/{serviceId}
{ "status": "ARCHIVED" }

200
{ "data": { "id": "...", "status": "ARCHIVED", ... } }
```

```
GET /v1/organizations/{orgId}/services?status=ACTIVE&q=corte&limit=20

200
{ "data": [ { "id": "...", "name": "Corte Masculino", "durationMinutes": 45, "price": "3500.00", ... } ] }
```

## Future consumers (documented now, not implemented — ADR-034/035)
A future `Appointment` (F27) will snapshot `id`/`name`/`price`/`durationMinutes` at creation time and never
re-read them from the live `Service` afterward. A future Scheduling module (F26) will read only
`durationMinutes`. A future `professional_services` join table (F25) will reference `Service` by composite FK
— none of this exists yet, and none of it requires any change to the contract above when it arrives.

## Not built in this slice (F24 brief §26)
Professionals, `professional_services`, Scheduling, Availability, Appointments, Booking, self-booking, Service
categories, Service variants, packages, locations, buffers, recurring schedules, payments, invoices, taxes,
discounts, notifications, multi-currency, accounting, a reporting engine.
