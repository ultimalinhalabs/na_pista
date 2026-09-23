# Order Management API (F23)

Base: `{NA_PISTA_API_URL}/v1`. Same envelope, versioning, and request pipeline as
[`products-api.md`](products-api.md): **1.** authenticate → **2.** resolve tenant → **3.** permission/scope →
**4.** `catalog.enabled` entitlement (reused unchanged — no `orders.enabled` invented, ADR-030) → **5.**
business logic → **6.** persist tenant-scoped → **7.** audit → **8.** usage.

## Model note (ADR-030/ADR-031/ADR-032)
`Order 1—N OrderItem`. `OrderItem.unitPrice`/`productName` are **snapshots**, copied from `Product` when the
item is created and never re-read afterward — a later Product price change or rename never touches an
existing OrderItem. `Order.currency` is a creation-time snapshot of the organization's single operating
currency (`AOA` in this phase). Lifecycle: `DRAFT → CONFIRMED → COMPLETED`, `CANCELED` reachable from `DRAFT`
or `CONFIRMED`. Inventory changes **only** at `DRAFT → CONFIRMED` (existing `ADJUSTMENT_OUT`) and is reversed
at `CONFIRMED → CANCELED` (existing `ADJUSTMENT_IN`) — see [`inventory-api.md`](inventory-api.md); no
Inventory schema change was made for Orders.

## `POST /organizations/:organizationId/orders`
- **Permission:** `orders.create` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request:** `{ "customerId"?: uuid, "items"?: [{ "productId": uuid, "quantity": number|string }] (max 100,
  default []) }` — `.strict()`: `unitPrice`/`productName`/`subtotal`/`total`/`currency`/`organizationId`/
  `status` are never accepted from the client, at either the order or item level (F23 brief §13/§14/§33) —
  they are always server-derived from the current `Product`.
- **Product price:** every item's `productId` must resolve, in this tenant, to a Product that is `ACTIVE` and
  has a non-null `price` — otherwise `404 PRODUCT_NOT_FOUND` / `409 PRODUCT_ARCHIVED` / `409
  PRODUCT_PRICE_REQUIRED` respectively, and nothing is created.
- **Customer:** if `customerId` is supplied, it must resolve, in this tenant, to an `ACTIVE` customer —
  `404 NOT_FOUND` (no such customer) or `409 CUSTOMER_ARCHIVED`. Omit it for an anonymous/walk-in Order.
- **Response `201`:** `{ id, organizationId, customerId, status: "DRAFT", currency, subtotal, total, items: [
  { id, productId, productName, quantity, unitPrice, subtotal, createdAt, updatedAt } ], createdAt, updatedAt }`.
- **Errors:** `400 VALIDATION_ERROR`, `401`, `403`, `404 NOT_FOUND`/`PRODUCT_NOT_FOUND`, `409
  PRODUCT_ARCHIVED`/`PRODUCT_PRICE_REQUIRED`/`CUSTOMER_ARCHIVED`, `503 UPSTREAM_UNAVAILABLE`.

## `GET /organizations/:organizationId/orders`
- **Permission:** `orders.read` (all roles) · **Scope:** `catalog.read`.
- **Query:** `status?: DRAFT|CONFIRMED|COMPLETED|CANCELED`, `customerId?: uuid`, `limit?: 1-100 (default 50)`.
- **Response `200`:** `Order[]` **without** `items` (a list-view summary, matching Products/Customers'
  list-view convention) — fetch the detail endpoint for items.

## `GET /organizations/:organizationId/orders/:orderId`
- Same auth/entitlement as list. **`404 ORDER_NOT_FOUND`** if it doesn't exist *or* belongs to another
  organization. **Response `200`:** the full `Order`, including `items`.

## `PATCH /organizations/:organizationId/orders/:orderId`
- **Permission:** `orders.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **DRAFT-only.** `409 INVALID_ORDER_STATE` for any other status.
- **Request:** `{ "customerId"?: uuid|null }` — currently the only field editable this way; `null` clears the
  association back to anonymous. Item changes go through their own endpoints below.

## `POST /organizations/:organizationId/orders/:orderId/items`
Adds one item to a **DRAFT** Order and recalculates `subtotal`/`total`.
- **Permission:** `orders.update` (OWNER/ADMIN/MANAGER) · **Scope:** `catalog.write`.
- **Request:** `{ "productId": uuid, "quantity": number|string }` — same Product-price/Product-status
  resolution as order creation.
- **Response `201`:** the full updated `Order` (with items).
- **Errors:** as creation, plus `409 INVALID_ORDER_STATE` if the Order is not DRAFT.

## `PATCH /organizations/:organizationId/orders/:orderId/items/:itemId`
Changes only the quantity of an existing item (DRAFT-only) — `unitPrice`/`productName` never change after an
item is created (ADR-031). Recalculates the item's `subtotal` and the Order's totals.
- **Request:** `{ "quantity": number|string }`.

## `DELETE /organizations/:organizationId/orders/:orderId/items/:itemId`
Removes an item from a **DRAFT** Order and recalculates totals. A physical delete — the only one in the Order
domain, safe specifically because a DRAFT item has no historical value yet (ADR-032).

## Lifecycle endpoints
No generic `DELETE /orders/:orderId` — the lifecycle model does not support a physical delete; **cancel** is
the explicit verb (F23 brief §24).

### `POST /organizations/:organizationId/orders/:orderId/confirm`
`DRAFT → CONFIRMED`. Inside one transaction: re-verifies the Order is `DRAFT` (a row-locking read — a second,
racing confirm request on the same Order blocks here and then fails cleanly, never double-consuming stock),
requires at least one item (`409 EMPTY_ORDER`), decreases Inventory for every item via the **existing**
`ADJUSTMENT_OUT` movement (re-checks each Product is still `ACTIVE`, `409 PRODUCT_ARCHIVED` otherwise), flips
`status`, writes an `order.confirmed` audit event — all-or-nothing. `409 INSUFFICIENT_STOCK` if any item's
stock is insufficient; **nothing partially commits** — an earlier item's already-applied stock decrease in the
same request rolls back too (proven with a real multi-item test, not asserted — see `docs/f23-report.md`
"Concurrency"/"Transaction boundary").

### `POST /organizations/:organizationId/orders/:orderId/cancel`
From `DRAFT`: pure state change, no Inventory effect. From `CONFIRMED`: reverses exactly the stock the Order
consumed at confirmation, via the **existing** `ADJUSTMENT_IN` movement (no new `RETURN` type). `409
INVALID_ORDER_STATE` from `COMPLETED`/`CANCELED` (terminal).

### `POST /organizations/:organizationId/orders/:orderId/complete`
`CONFIRMED → COMPLETED` only. No Inventory effect — stock was already consumed at confirmation and is never
touched again. `409 INVALID_ORDER_STATE` from any other status.

## Idempotency
Every lifecycle transition is a single atomic conditional operation guarded by a row lock (see "confirm"
above) — a retried/duplicate confirm/cancel/complete request on an Order that has already transitioned
observes the real current status and fails with `409 INVALID_ORDER_STATE`, never double-applying its effect
(F23 brief §22/§44). No general distributed idempotency-key system was introduced for this.

## Money and rounding (ADR-029)
`unitPrice`/`subtotal`/`total` are decimal strings (`"10000.00"`), never floats, computed via Postgres's exact
`numeric` arithmetic (`ROUND(unit_price * quantity, 2)`, round-half-away-from-zero — confirmed empirically
against the real database, see `docs/f23a-report.md`). Rounding happens once, at the line-item boundary;
`Order.subtotal`/`total` are the plain sum of already-rounded, stored line subtotals — never recomputed from
an average, never re-rounded on read.

## Currency (ADR-030)
`Order.currency` is set once, at creation, from the organization's single operating currency (`AOA` in this
phase) — never re-derived afterward, never accepted from the client, never varies per item.

## Tenant isolation
Identical posture to every prior module: `organization_id NOT NULL` on `orders`/`order_items`, composite FKs
`(organization_id, order_id) → orders`, `(organization_id, product_id) → products`,
`(organization_id, customer_id) → customers` (nullable), and a repository that cannot run without a resolved
`TenantContext`. Cross-organization access resolves to `403` (no membership/wrong credential) or `404` (real
membership, wrong resource) — never the other organization's data.

## Examples

```
POST /v1/organizations/{orgId}/orders
Authorization: Bearer <token>

{ "customerId": "...", "items": [ { "productId": "...", "quantity": 2 } ] }

201
{ "data": { "id": "...", "status": "DRAFT", "currency": "AOA", "subtotal": "20000.00",
            "total": "20000.00", "customerId": "...",
            "items": [ { "id": "...", "productId": "...", "productName": "Camisola Azul",
                         "unitPrice": "10000.00", "quantity": "2.000000",
                         "subtotal": "20000.00" } ] } }
```

```
POST /v1/organizations/{orgId}/orders/{orderId}/confirm

409
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "Insufficient stock for product \"...\"" } }
```

## Not built in this slice (F23 brief §4/§48)
Payments, invoices, fiscal documents, discounts/coupons/promotions, taxes, shipping/delivery, refunds,
installments, credit/receivables, supplier purchasing, accounting/profit, multi-currency/exchange rates, stock
reservations, advanced reporting/analytics, notifications.
