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
- **Request:** `{ "name": string (1-200), "description"?: string (≤2000), "categoryId"?: uuid, "unit"?:
  "UNIT"|"KG"|"G"|"L"|"ML" (default "UNIT", ADR-027), "price"?: number|string }`. `price` accepts a JSON
  number or decimal string, normalized to a fixed 2-decimal string (ADR-029); omit it to leave the Product
  unpriced (`null`) — see "Pricing" below.
- **Response `201`:** `{ id, organizationId, categoryId, name, description, unit, price, status: "ACTIVE",
  createdAt, updatedAt }`. `price` is `null` when unset.
- **Errors:** as Categories, plus `400 VALIDATION_ERROR` if `categoryId` is well-formed but does not belong to
  this organization (never a raw foreign-key/database error), or if `price` is negative/NaN/Infinity.

### `GET /organizations/:organizationId/products`
- **Permission:** `products.read` (all roles) · **Scope:** `catalog.read`.
- **Query:** `status?: ACTIVE|ARCHIVED`, `categoryId?: uuid`, `q?: string (name, case-insensitive substring)`, `limit?: 1-100 (default 50)`.
- **Response `200`:** `Product[]`, newest first. No offset pagination in this slice — a hard, safe `limit` cap
  instead (F20 brief §30).

### `GET /organizations/:organizationId/products/:productId`
- Same posture as Categories' detail endpoint — `404` for cross-tenant/nonexistent, uniformly.

### `PATCH /organizations/:organizationId/products/:productId`
- **Permission:** `products.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request:** `{ name?, description?: string|null, categoryId?: uuid|null, status?: "ACTIVE"|"ARCHIVED",
  unit?, price?: number|string|null }`. `price: null` explicitly clears it back to "not yet priced" — distinct
  from `price: 0` ("deliberately free"), see "Pricing" below.
- Re-pointing `categoryId` at another organization's category is rejected the same way creation is.

### `DELETE /organizations/:organizationId/products/:productId`
- **Permission:** `products.delete` (OWNER/ADMIN only) · **Scope:** `catalog.write`.
- **Effect:** archives (ADR-020), same posture as Categories' DELETE.

## Pricing (F23, ADR-031)
`Product.price` is `numeric(14,2)`, **nullable** — a single current, mutable selling price, no history table,
no price lists (no demonstrated requirement). `null` ("not yet priced") and `0` ("deliberately free — sample,
promotional, complimentary") are distinct, both valid; only negative/non-finite values are rejected. A Product
with `price: null` exists and is fully manageable here, but **cannot be added to an Order** until priced — see
[`orders-api.md`](orders-api.md) "Product price" for the exact enforcement point. Changing a Product's price
here only affects **future** Orders — any `OrderItem` already created keeps its own price snapshot regardless
of later changes here (ADR-031).

## Not built in this slice (explicitly, F20 brief §32; superseded for pricing by F23/ADR-031)
Full Customers (F21), Inventory (F22), Orders (F23) are covered in their own API docs. Still not built:
variants, warehouses, barcode/SKU, suppliers, purchasing, POS, invoices, taxes, payments, delivery, loyalty,
advanced analytics, price history/price lists.

## Machine-readable contract
No OpenAPI document is generated in this pass — the shapes above are hand-written from the real Zod schemas
(`src/modules/*/schemas.ts`) and route files (`src/modules/*/routes.ts`), the same way F18's `api-boundary.md`
was written from the Platform's own code. Generating OpenAPI from the Zod schemas is a reasonable follow-up
(`zod-to-openapi` or similar) — not done here to avoid adding a new dependency/build step without a concrete
consumer asking for it yet.
