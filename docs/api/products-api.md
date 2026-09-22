# Product Management API (F20)

Base: `{NA_PISTA_API_URL}/v1`. Envelope: `{ "data": ... }` on success, `{ "error": { "code", "message" } }` on
failure (`api-boundary.md`). Every response carries `X-Request-ID`. Versioned from the start (`/v1`).

Every endpoint below, in order: **1.** authenticate (human JWT or `ulk_` service credential) → **2.** resolve
tenant (`:organizationId` validated against real membership or credential scope) → **3.** check permission
(human) or scope (service) → **4.** check `catalog.enabled` entitlement → **5.** run the business operation →
**6.** persist tenant-scoped → **7.** audit → **8.** record usage.

## Categories

### `POST /organizations/:organizationId/categories`
- **Auth:** human JWT or `ulk_` service credential.
- **Permission:** `categories.create` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Entitlement:** `catalog.enabled`.
- **Request:** `{ "name": string (1-200), "description"?: string (≤2000) }` — unknown fields rejected.
- **Response `201`:** `{ id, organizationId, name, description, status: "ACTIVE", createdAt, updatedAt }`.
- **Errors:** `400 VALIDATION_ERROR`, `401 UNAUTHORIZED`, `403 FORBIDDEN`/`ENTITLEMENT_REQUIRED`, `503 UPSTREAM_UNAVAILABLE`.
- **Tenant:** the category belongs to the caller's own organization; never client-supplied.

### `GET /organizations/:organizationId/categories`
- **Permission:** `categories.read` (all roles) · **Scope:** `catalog.read`.
- **Query:** `status?: ACTIVE|ARCHIVED`, `limit?: 1-100 (default 50)`.
- **Response `200`:** `Category[]`, newest first.

### `GET /organizations/:organizationId/categories/:categoryId`
- Same auth/entitlement as list. **`404`** if the category doesn't exist *or* belongs to another organization — never `403` for that case, never distinguishable from "doesn't exist".

### `PATCH /organizations/:organizationId/categories/:categoryId`
- **Permission:** `categories.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request (all optional, unknown fields rejected):** `{ name?, description?: string|null, status?: "ACTIVE"|"ARCHIVED" }`.
- `id`, `organizationId`, `createdAt`, `updatedAt` are never accepted from the client.

### `DELETE /organizations/:organizationId/categories/:categoryId`
- **Permission:** `categories.delete` (OWNER/ADMIN only) · **Scope:** `catalog.write`.
- **Effect:** sets `status = ARCHIVED` (ADR-020) — **never a physical delete**. Response `200` with the
  updated resource, still fully readable afterwards via `GET`.

## Products

### `POST /organizations/:organizationId/products`
- **Permission:** `products.create` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Entitlement:** `catalog.enabled`.
- **Request:** `{ "name": string (1-200), "description"?: string (≤2000), "categoryId"?: uuid }`.
- **Response `201`:** `{ id, organizationId, categoryId, name, description, status: "ACTIVE", createdAt, updatedAt }`.
- **Errors:** as Categories, plus `400 VALIDATION_ERROR` if `categoryId` is well-formed but does not belong to
  this organization (never a raw foreign-key/database error).

### `GET /organizations/:organizationId/products`
- **Permission:** `products.read` (all roles) · **Scope:** `catalog.read`.
- **Query:** `status?: ACTIVE|ARCHIVED`, `categoryId?: uuid`, `q?: string (name, case-insensitive substring)`, `limit?: 1-100 (default 50)`.
- **Response `200`:** `Product[]`, newest first. No offset pagination in this slice — a hard, safe `limit` cap
  instead (F20 brief §30).

### `GET /organizations/:organizationId/products/:productId`
- Same posture as Categories' detail endpoint — `404` for cross-tenant/nonexistent, uniformly.

### `PATCH /organizations/:organizationId/products/:productId`
- **Permission:** `products.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request:** `{ name?, description?: string|null, categoryId?: uuid|null, status?: "ACTIVE"|"ARCHIVED" }`.
- Re-pointing `categoryId` at another organization's category is rejected the same way creation is.

### `DELETE /organizations/:organizationId/products/:productId`
- **Permission:** `products.delete` (OWNER/ADMIN only) · **Scope:** `catalog.write`.
- **Effect:** archives (ADR-020), same posture as Categories' DELETE.

## Not built in this slice (explicitly, F20 brief §32)
Inventory, Orders, full Customers, variants, warehouses, barcode/SKU, suppliers, purchasing, POS, invoices,
taxes, payments, delivery, loyalty, advanced analytics. A `price` field is deferred to when F18's OD-01
(currency/decimalization) closes.

## Machine-readable contract
No OpenAPI document is generated in this pass — the shapes above are hand-written from the real Zod schemas
(`src/modules/*/schemas.ts`) and route files (`src/modules/*/routes.ts`), the same way F18's `api-boundary.md`
was written from the Platform's own code. Generating OpenAPI from the Zod schemas is a reasonable follow-up
(`zod-to-openapi` or similar) — not done here to avoid adding a new dependency/build step without a concrete
consumer asking for it yet.
