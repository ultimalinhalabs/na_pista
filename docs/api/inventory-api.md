# Inventory Management API (F22)

Base: `{NA_PISTA_API_URL}/v1`. Same envelope, versioning, and request pipeline as
[`products-api.md`](products-api.md): **1.** authenticate → **2.** resolve tenant → **3.** permission/scope →
**4.** `catalog.enabled` entitlement → **5.** business logic → **6.** persist tenant-scoped → **7.** audit →
**8.** usage.

## Model note (ADR-027/ADR-028)
Inventory is `Product → InventoryBalance → StockMovement`. `InventoryBalance` holds only the *current*
quantity for a `(organization, product)` pair (`UNIQUE(organization_id, product_id)` — one balance per
product, no locations/warehouses in this slice). `StockMovement` is the append-only ledger every balance
change is provably derived from. **There is no `PATCH` to overwrite a quantity directly** — the only way to
change a balance is `POST .../movements`. A balance does not exist until the product's first `RECEIPT`
(lazy creation).

## `GET /organizations/:organizationId/inventory`
- **Permission:** `inventory.read` (all roles) · **Scope:** `catalog.read`.
- **Query:**
  - `zeroStock?: boolean` — when `true`, returns only balances at exactly `0`. There is no `lowStock` filter
    in this slice — see "Deferred: low-stock threshold" below.
  - `zeroStock` accepts exactly `true`/`false` (F30; `false` = no filter — it used to behave like `true`).
  - **Pagination & sorting (F30, ADR-051/052):** `page` (default 1), `pageSize` (default 50, max 100; `limit` = deprecated alias), `sort` ∈ {`updatedAt`, `quantity`} + `order=asc|desc`. The response adds `pagination: { page, pageSize, total, totalPages }` beside `data` — see [pagination.md](pagination.md).
- **Response `200`:** `InventoryBalance[]` (joined with the product for `productName`/`productUnit`/
  `productStatus`), newest-updated first. Includes balances for archived products.

## `GET /organizations/:organizationId/inventory/:productId`
- Same auth/entitlement as list.
- **Response `200`:** a single `InventoryBalance`.
- **Errors:** `404 PRODUCT_NOT_FOUND` (no such product in this tenant) vs. `404 INVENTORY_NOT_FOUND` (the
  product exists but has never received a `RECEIPT`) — deliberately distinguished (F22 brief §30) so a client
  can tell "wrong id" apart from "not stocked yet".

## `GET /organizations/:organizationId/inventory/:productId/movements`
- Same auth/entitlement as list. Requires the product to exist (`404 PRODUCT_NOT_FOUND` otherwise); an empty
  array is a valid, non-error response for a never-stocked product.
- **Pagination & sorting (F30, ADR-051/052):** `page` (default 1), `pageSize` (default 50, max 100; `limit` = deprecated alias), fixed order (no `sort`). The response adds `pagination: { page, pageSize, total, totalPages }` beside `data` — see [pagination.md](pagination.md).
- **Response `200`:** `StockMovement[]`, newest first.

## `POST /organizations/:organizationId/inventory/:productId/movements`
The only inventory write in this slice. Every quantity change is provably a movement, by construction.

- **Permission:** depends on the request body's `type` (F22 brief §19 — checked inline in the route handler,
  after body validation, using the same `roleHasPermission`/scope primitives every other route uses; not a
  second authorization mechanism):
  - `type: "RECEIPT"` → `inventory.create` (OWNER/ADMIN/MANAGER).
  - `type: "ADJUSTMENT_IN" | "ADJUSTMENT_OUT"` → `inventory.update` (OWNER/ADMIN/MANAGER).
  - STAFF has neither — read-only. **No role ever has `inventory.delete`** — there is no lifecycle operation
    to delete; a mistaken movement is corrected with a compensating movement, never erased.
  - **Scope:** `catalog.write` for a service credential, regardless of `type`.
- **Entitlement:** `catalog.enabled`.
- **Request:** `{ "type": "RECEIPT"|"ADJUSTMENT_IN"|"ADJUSTMENT_OUT", "quantity": number|string, "reason"?:
  string (≤500) }` — unknown/protected fields rejected (`.strict()`).
  - `quantity` is **always positive**; direction comes from `type`, never from sign. Accepts a JSON number or
    a decimal string; always normalized to a fixed 6-decimal string before reaching Postgres
    (`numeric(20,6)`, mirroring `ul-platform`'s own `usage_events.quantity` convention). Zero, negative,
    `NaN`, `Infinity`, and anything beyond `numeric(20,6)`'s representable range (14 integer digits, 6
    decimal — `99999999999999.999999`) are rejected with `400 VALIDATION_ERROR`.
- **Response `201`:** `{ balance: InventoryBalance, movement: StockMovement }` — both reflect the
  post-transaction state.
- **Errors:**
  - `400 VALIDATION_ERROR` — bad body.
  - `404 PRODUCT_NOT_FOUND` — no such product in this tenant.
  - `409 PRODUCT_ARCHIVED` — the product exists but is archived; its existing balance/history remain readable,
    but no new movement is accepted.
  - `409 INSUFFICIENT_STOCK` — an `ADJUSTMENT_OUT` that would take the balance below zero (including against a
    product with no balance row at all — treated as zero, same error, no distinction; ADR-028). **No partial
    effect**: balance unchanged, no movement row inserted.
  - `401 UNAUTHORIZED`, `403 FORBIDDEN`/`ENTITLEMENT_REQUIRED`, `503 UPSTREAM_UNAVAILABLE`.

### Atomicity and concurrency (ADR-028)
One `db.transaction`: re-check product existence/archived status → apply the balance change with a single,
self-contained SQL statement (`INSERT ... ON CONFLICT DO UPDATE` for an increase; a conditional `UPDATE ...
WHERE quantity >= $delta` for a decrease) → insert the movement → insert the audit event. Any failure rolls
back everything. The conditional `UPDATE`'s `WHERE` guard is evaluated as part of the same row-locking
statement as the write itself — there is no separate read-then-check-then-write step for a concurrent second
writer to interleave with, which is what makes two simultaneous decreases against the same balance resolve to
"exactly one succeeds" rather than a lost update. Proven with real concurrent Postgres transactions, not
asserted — see `docs/f22-report.md` "Concurrency" for the exact scenario and measured result.

## Entitlement
Gated by `catalog.enabled` — the same key Products/Categories/Customers already use (ADR-022), reused rather
than a new `inventory.enabled` invented for this slice.

## Tenant isolation
Identical posture to Products/Categories/Customers: `organization_id NOT NULL` on both `inventory_balances`
and `stock_movements`, a composite foreign key `(organization_id, product_id) → products(organization_id,
id)` (the same pattern ADR-021 established for `products → categories`) so a product from Organization B can
never receive inventory belonging to Organization A — proven structurally by Postgres, not just application
code — and a repository that cannot run without a resolved `TenantContext`. Cross-organization access resolves
to `403` (no membership/wrong credential) or `404` (real membership, wrong resource) — never the other
organization's data.

## Examples

```
POST /v1/organizations/{orgId}/inventory/{productId}/movements
Authorization: Bearer <token>

{ "type": "RECEIPT", "quantity": 20, "reason": "Initial stock" }

201
{ "data": { "balance": { "id": "...", "organizationId": "...", "productId": "...",
                          "quantity": "20.000000", "createdAt": "...", "updatedAt": "..." },
            "movement": { "id": "...", "type": "RECEIPT", "quantity": "20.000000",
                           "reason": "Initial stock", "actorType": "user", "actorId": "...",
                           "createdAt": "..." } } }
```

```
POST /v1/organizations/{orgId}/inventory/{productId}/movements
{ "type": "ADJUSTMENT_OUT", "quantity": 999 }

409
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Insufficient stock for product \"...\"" } }
```

```
GET /v1/organizations/{orgId}/inventory?zeroStock=true

200
{ "data": [ { "id": "...", "productId": "...", "productName": "...", "quantity": "0.000000", ... } ] }
```

## Deferred: low-stock threshold (F22 brief §16)
Not built. A `lowStock` filter would require a per-product minimum-stock threshold, a field this slice's
Product model does not have and no requirement asked for. Adding it speculatively is exactly what F18 §14 and
F22 §2 both rule out. `zeroStock` (well-defined, no threshold needed) is offered instead.

## Not built in this slice (F22 brief §5/§27)
Multi-location/warehouse inventory, unit-conversion engine or per-organization custom units, backorders,
reservations, SALE/ORDER_RESERVATION/RETURN/TRANSFER movement types, low-stock alerts/notifications, batch/lot
tracking, expiry dates, serial numbers, supplier/purchase-order integration, cost/valuation (FIFO/weighted
average), barcode scanning.
