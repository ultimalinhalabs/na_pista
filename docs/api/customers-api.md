# Customer Management API (F21)

Base: `{NA_PISTA_API_URL}/v1`. Same envelope, versioning, and request pipeline as
[`products-api.md`](products-api.md): **1.** authenticate → **2.** resolve tenant → **3.** permission/scope →
**4.** `catalog.enabled` entitlement → **5.** business logic → **6.** persist tenant-scoped → **7.** audit →
**8.** usage.

## Identity note (ADR-025)
A Customer is a Na Pista business record, **never** a UL Platform user/account. It has no relationship to
Supabase Auth, no `userId`, and creating one never touches the Platform's identity system. A business may
register a customer who has never signed in to anything.

## `POST /organizations/:organizationId/customers`
- **Permission:** `customers.create` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Entitlement:** `catalog.enabled` (see "Entitlement" below).
- **Request:** `{ "name": string (1-200), "email"?: string (valid email, ≤320), "phone"?: string (loose
  international shape, e.g. "+244923456789"), "notes"?: string (≤2000) }` — unknown fields rejected,
  including `status`/`id`/`organizationId`/`createdAt`/`updatedAt`.
- **Response `201`:** `{ id, organizationId, name, email, phone, notes, status: "ACTIVE", createdAt, updatedAt }`.
- **Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`/`ENTITLEMENT_REQUIRED`, `503 UPSTREAM_UNAVAILABLE`.

## `GET /organizations/:organizationId/customers`
- **Permission:** `customers.read` (all roles) · **Scope:** `catalog.read`.
- **Query:**
  - `status?: ACTIVE|ARCHIVED` — omit for no filter; the UI defaults to `ACTIVE`.
  - `q?: string` — matches `name`, `email`, or `phone` (case-insensitive substring), tenant-scoped. No
    full-text engine.
  - **Pagination & sorting (F30, ADR-051/052):** `page` (default 1), `pageSize` (default 50, max 100; `limit` = deprecated alias), `sort` ∈ {`createdAt`, `name`} + `order=asc|desc`. The response adds `pagination: { page, pageSize, total, totalPages }` beside `data` — see [pagination.md](pagination.md).
- **Response `200`:** `Customer[]`, newest first.

## `GET /organizations/:organizationId/customers/:customerId`
- Same auth/entitlement as list. **`404`** if the customer doesn't exist *or* belongs to another organization
  — indistinguishable, never `403` for that case. Returns the resource **regardless of `status`** — an
  archived customer is still readable by id.

## `PATCH /organizations/:organizationId/customers/:customerId`
- **Permission:** `customers.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request (all optional, unknown fields rejected):** `{ name?, email?: string|null, phone?: string|null,
  notes?: string|null, status?: "ACTIVE"|"ARCHIVED" }`. Passing `null` explicitly clears `email`/`phone`/`notes`.
- `id`, `organizationId`, `createdAt`, `updatedAt` are never accepted from the client.
- Setting `status: "ACTIVE"` on an archived customer un-archives it — no separate restore endpoint.

## `DELETE /organizations/:organizationId/customers/:customerId`
- **Permission:** `customers.delete` (OWNER/ADMIN only) · **Scope:** `catalog.write`.
- **Effect:** sets `status = ARCHIVED` (ADR-026) — **never a physical delete**. `200` with the updated
  resource; still fully readable afterwards via `GET`, excluded only from a `status=ACTIVE`-filtered list.

## Entitlement
Gated by `catalog.enabled` — the same key Products/Categories already use (ADR-022), reused rather than a new
`customers.enabled` invented for this slice. See `docs/f21-report.md` "Entitlement" for the full reasoning
(no better Platform capability exists today; inventing one wasn't justified).

## Tenant isolation
Identical posture to Products/Categories: `organization_id NOT NULL`, a repository that cannot run without a
resolved `TenantContext`, and every cross-organization access attempt resolves to `403` (no membership/wrong
credential) or `404` (real membership, wrong resource) — never the other organization's data, never
distinguishable from "doesn't exist" for the `404` case.

## Uniqueness (ADR-024)
No uniqueness constraint on `name`, `email`, or `phone` — a shared family phone, a customer with no email, or
duplicate names are all legitimate. `409 CONFLICT` is not reachable through any endpoint in this slice; the
error-mapping machinery is preserved for the day a real constraint is added.

## Examples

```
POST /v1/organizations/{orgId}/customers
Authorization: Bearer <token>

{ "name": "Ana Silva", "phone": "+244923456789", "email": "ana.silva@example.com" }

201
{ "data": { "id": "...", "organizationId": "...", "name": "Ana Silva", "email": "ana.silva@example.com",
            "phone": "+244923456789", "notes": null, "status": "ACTIVE",
            "createdAt": "...", "updatedAt": "..." } }
```

```
GET /v1/organizations/{orgId}/customers?q=ana&status=ACTIVE&pageSize=20

200
{ "data": [ { "id": "...", "name": "Ana Silva", ... } ] }
```

## Not built in this slice (F21 brief §24)
CRM, leads/opportunities, marketing automation, loyalty, segmentation, scoring, messaging/WhatsApp
integration, order/appointment history, customer self-service portal, payments/invoices/billing, advanced
analytics.
