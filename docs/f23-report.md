# F23 Report — Order Management Vertical Slice

## Status

**COMPLETE.** Every Definition of Done item (F23 brief §49) is proven, not asserted — see "Tests" and "Self
review" below. Orders is Na Pista's fourth real business module and its first Commerce domain, implementing
F23A's decision package (ADR-029..032) exactly as its own non-negotiable contract, with zero reinterpretation:
money, currency, pricing, lifecycle, and the Order/Inventory boundary are all implemented precisely as F23A
specified.

## Scope delivered
`na_pista.orders` + `na_pista.order_items` (own migration, plus `products.price` and two composite-FK-target
unique indexes added to existing tables), tenant-scoped repository with server-computed totals (SQL `SUM`/
`ROUND`, never JS arithmetic), full Order lifecycle (`DRAFT → CONFIRMED → COMPLETED`/`CANCELED`) reusing F22's
Inventory service **unchanged** for the Order/Inventory boundary, `.strict()` Zod validation that makes price
manipulation structurally impossible, `orders.*` permissions, transactional audit, real Platform usage, 71
order-specific tests (17 unit + 22 integration + 32 E2E) — including the mandatory concurrency proof — Default
UI (list/detail/create/edit-while-DRAFT/lifecycle actions) following `DESIGN.md`, API documentation, no UL
Platform production code touched.

## Order model
`{ id, organizationId, customerId?, status, currency, subtotal, total, createdAt, updatedAt }` — exactly F23A's
§18 contract, no extra fields (no payment status, tax total, discount total, shipping total, payment method,
delivery address, invoice number — none justified, none added). `customerId` nullable (closes OD-03, confirms
F18's own PD-8 recommendation) — anonymous/walk-in Orders are a first-class case, proven end to end.

## OrderItem model
`{ id, organizationId, orderId, productId, productName, quantity, unitPrice, subtotal, createdAt, updatedAt }`.
`productName`/`unitPrice` are snapshots copied from `Product` at creation time and never re-read afterward —
proven with the exact Day-1/Day-2 scenario F23A's brief describes (`tests/integration/orders.test.ts` test 1).
`quantity` deliberately reuses Inventory's own `numeric(20,6)` representation and Zod validation (exported and
imported, not duplicated) — not assumed, decided because a future `StockMovement` created at confirmation
consumes this exact value.

## Pricing model (ADR-031)
`Product.price numeric(14,2)`, nullable — added to the existing `products` table (F20's own comment already
anticipated this: "price_minor/currency_code are additive columns, not a redesign" — realized here as
`numeric(14,2)`, per ADR-029's reasoned departure from F18's original minor-units proposal). `NULL` ("not yet
priced") and `0` ("deliberately free") are distinct and both proven valid. Enforcement that a Product must have
a price lives at Order-item-creation time (`PRODUCT_PRICE_REQUIRED`), never at Product creation — a Product can
exist unpriced, matching every existing F20/F21/F22 Product's real state today (migration-compatible by
construction: the new column is nullable, no existing row needed a fake value).

## Money calculations (ADR-029)
Every multiplication and rounding step happens in Postgres SQL, never in JavaScript: `line.subtotal =
ROUND(unit_price::numeric * quantity::numeric, 2)` at item-insert time, and `order.subtotal`/`order.total =
(SELECT COALESCE(SUM(subtotal), 0) FROM order_items WHERE order_id = ...)` recomputed from the actual stored
rows on every item add/remove/quantity-change (`recalculateOrderTotals`) — never carried forward incrementally,
so a total can never drift from what its items actually say. Proven exact with real multi-item sums
(`999.99×3 + 0.01×1 = 2999.98`, no float artifact) and with F23A's own validated tie-case
(`2.00 × 0.0625 = 0.125 → 0.13`, round-half-away-from-zero) — both in `tests/integration/orders.test.ts`.

## Currency (ADR-030)
`Order.currency` is a creation-time snapshot (`"AOA"` — the F23A-approved single supported currency, since a
real `TenantSettings`/organization-currency table does not exist yet; this is a known, explicitly documented
limitation, not a silent shortcut — see below). Never stored on `Product`. Never accepted from the client
(`.strict()` schemas don't even have the field). One currency per Order by construction — no per-item currency
field exists to disagree with it.

## Customer relationship
Reuses F21's `Customer` domain completely unmodified — no new customer representation, no coupling to Supabase
User. `customerId` resolved, tenant-scoped, via the existing `getCustomer` repository function; must be
`ACTIVE` to be assigned to a **new** Order or a DRAFT's customer change (`CUSTOMER_ARCHIVED` otherwise) — a
historical Order that already references a customer later archived remains fully valid and readable (proven:
`tests/integration/orders.test.ts` test 21).

## Lifecycle (ADR-032)
`DRAFT → CONFIRMED → COMPLETED` (terminal); `CANCELED` reachable from `DRAFT` or `CONFIRMED` (terminal). Every
transition is a single transaction that begins with `SELECT ... FOR UPDATE` on the Order row — the same
"let Postgres serialize it" philosophy ADR-028 already established for balance mutation, applied to
`Order.status` — making every transition idempotent and race-safe by construction: a second, retried, or
concurrent lifecycle request on the *same* Order blocks until the first resolves, then observes the real
current status and fails cleanly (`INVALID_ORDER_STATE`) rather than double-applying its effect. Items are
mutable only in `DRAFT` (guarded the same way); terminal Orders (`COMPLETED`/`CANCELED`) reject every mutation
attempt — proven directly (`tests/integration/orders.test.ts` test 23).

## Inventory integration — the Order/Inventory boundary
**Zero changes to `src/db/schema/inventory.ts` or `src/modules/inventory/repository.ts`.** Order confirmation
calls the *existing* `inventory/service.ts` `createMovement` function, unmodified in its business logic, for
each item (`ADJUSTMENT_OUT`); cancellation-from-`CONFIRMED` calls it again (`ADJUSTMENT_IN`) to reverse exactly
what was consumed. The **one** change made to `createMovement` (documented, minimal, exactly per the brief's
own explicit permission, §43: "refactor minimally so the same transaction context can be passed safely") is an
optional `externalTx` parameter: when Order's own `db.transaction` passes its own transaction through,
`createMovement` participates in it directly instead of opening a nested one — making Order status + every
stock movement + the audit event commit or roll back together, atomically, without Orders ever touching
`inventory_balances`/`stock_movements` directly. Every existing F22 caller (the standalone
`POST .../inventory/:id/movements` route, all 48 of F22's own tests) passes no `externalTx` and is provably
unaffected — confirmed by re-running F22's full test suite after this change (still 48/48, see "Tests").

Traceability from a `StockMovement` to the Order that caused it is via the movement's existing free-text
`reason` field (`"Order {id} confirmed"`/`"Order {id} canceled"`) — a named limitation (ADR-032), not an
oversight: a first-class `orderId` FK on `stock_movements` is the correct long-term fix, deliberately deferred
because it is an Inventory schema change the brief instructs this phase not to make.

## Transaction boundary (F23 brief §43 — the most important part of F23)
```
db.transaction(async (tx) => {
  order = SELECT ... FOR UPDATE (locks the Order row, reads the real current status)
  assert order.status === "DRAFT"
  items = SELECT order_items WHERE order_id = ...
  assert items.length > 0
  for each item: createMovement(..., tx)   // ADJUSTMENT_OUT, participates in THIS transaction
  UPDATE orders SET status = 'CONFIRMED'
  INSERT audit_events (order.confirmed)
})
// only after the transaction above COMMITS:
recordUsage(...)   // fire-and-forget, never affects the mutation
```
One transaction, one connection, the real `na_pista` Postgres database both Orders and Inventory already live
in — no distributed transaction, no new transaction framework, per the brief's own explicit instruction.
Proven with a real forced failure, not just code review: a 2-item Order where the 2nd item has insufficient
stock — confirmation fails, and the **1st item's already-applied stock decrease rolls back too**
(`tests/integration/orders.test.ts` test 13, "confirmation atomicity") — and with a genuine Postgres audit-
insert failure inside the same transaction, confirming both the status change and the stock movement fail to
persist together (test 19).

## Concurrency — the mandatory proof (F23 brief §42)
`tests/integration/orders.test.ts`, "CONCURRENCY": stock = 10; Order A and Order B each request 7; both
confirmed via `Promise.allSettled` over genuinely independent, concurrently-opened `db.transaction`s (real
parallel Postgres transactions, not sequential `await`s). Measured, real result:

| | Result |
|---|---|
| Order A | one of {CONFIRMED, DRAFT} |
| Order B | the other of {CONFIRMED, DRAFT} |
| Final stock | **3** |
| ADJUSTMENT_OUT movements | **1** |

Exactly one Order reaches `CONFIRMED`; the other's `confirmOrder` call rejects with `InsufficientStockError`
and the Order is left untouched in `DRAFT` — never both `CONFIRMED`, never negative stock, never two movements.
This is **F22's own proven atomic conditional-`UPDATE` mechanism, reused completely unchanged** — no new
concurrency logic was written for Orders at all, exactly per the brief's own instruction not to duplicate it.

## Tenant isolation
Identical posture to every prior module: `organization_id NOT NULL` on both `orders` and `order_items`,
composite FKs `(organization_id, order_id) → orders`, `(organization_id, product_id) → products`,
`(organization_id, customer_id) → customers` (nullable), and a repository that cannot run without a resolved
`TenantContext`. Proven at all three layers the brief asks for (§29): application (repository tenant guard,
unit-tested), HTTP (cross-org list/GET/mutate all correctly blocked, E2E-tested), and PostgreSQL (a direct raw
insert into `order_items` referencing another organization's product is rejected by the composite FK —
integration-tested, asserting on the real Postgres error, not a mock).

## Authorization
`orders.create` gates `POST /orders`; `orders.update` gates every other mutation — item add/remove/quantity-
change, the customer `PATCH`, and all three lifecycle transitions (confirm/cancel/complete) alike. Deliberately
**not** split further per-transition (brief §27's own instruction: "do not invent unnecessary permission
granularity") — every Order mutation is the same class of action on the same resource, unlike Inventory's
create/update split (which reflects two genuinely different actions, RECEIPT vs. ADJUSTMENT). OWNER/ADMIN/
MANAGER: full read+write, identical (mirrors Inventory's own OWNER=ADMIN=MANAGER pattern — no requirement
distinguishes them for Orders either). STAFF: read only. **No `orders.delete`** — Orders are never physically
deleted; cancellation is a lifecycle transition gated like any other mutation, not a separate permission tier
(mirrors `inventory.delete`'s deliberate absence, ADR-028).

## Entitlement
Reuses `catalog.enabled` (ADR-022, unchanged) — no `orders.enabled` invented, per the brief's explicit
instruction and F23A/ADR-030's own reasoning (every module so far shares this one "Na Pista access" gate;
Orders is not treated differently without a requirement to justify it).

## Audit
`order.created`, `order.updated` (items/customer changes while DRAFT), `order.confirmed`, `order.canceled`,
`order.completed` — all in the same transaction as the mutation they describe (ADR-023's established pattern,
restated). No customer name/email/phone/payment information in metadata — only opaque ids (`customerId`,
`productId`, item counts, changed-field lists) — confirmed by direct code inspection of every
`recordAuditEvent` call in `orders/service.ts`.

## Usage
`api_requests` meter (F20/F21/F22's established, real, Platform-seeded choice) — no `orders.created`/
`orders.confirmed` meter invented, per the brief's explicit instruction. Recorded on `order.created` and on
each of the three lifecycle transitions (confirm/cancel/complete) — meaningful business milestones, matching
F22's per-movement recording philosophy — but deliberately **not** on item add/remove/quantity-change or the
customer `PATCH`, matching F20/F21's own established choice to record usage only on "create"-class events, not
every field edit. Proven live: a real Order write measurably increases the Platform's own recorded usage;
fire-and-forget, never blocks the mutation (unchanged `platform/usage.ts` mechanism).

## API
`/v1/organizations/:organizationId/orders` — create/list/detail/PATCH(customer)/items sub-resource
(add/update-quantity/remove)/explicit lifecycle endpoints (`confirm`/`cancel`/`complete`, no generic `DELETE`).
Full contract: [`docs/api/orders-api.md`](api/orders-api.md).

## Database
Real `drizzle-kit` migration (`0003_youthful_redwing.sql`) adding `orders`, `order_items`, `products.price`,
and two composite-FK-target unique indexes (`orders_org_id_unique`, `customers_org_id_unique` — the latter
newly needed because Order is the first thing that ever references Customer by FK). Hit the same drizzle-kit
FK-before-unique-index ordering bug already documented in F20/F22's migrations — manually reordered, applied
cleanly, verified with a direct schema/FK query against the real database (8 tables, 7 FKs, all correct).

## Tests

| Layer | Order-specific | Result |
|---|---|---|
| Unit | 17 | 17 pass |
| Integration (real Postgres) | 22 | 22 pass |
| E2E (real Platform + real Na Pista + real Postgres) | 32 | 32 pass |
| **Order total** | **71** | **71 pass, 0 fail** |

`na-pista`'s full root suite in the same runs (Orders + F20/F21/F22's unchanged Categories/Products/Customers/
Inventory code — including re-running all 48 Inventory tests to prove the `createMovement` refactor is
byte-for-byte backward compatible): **56 unit + 47 integration + 95 E2E = 198 tests.**

**Deliberately not duplicated from F19/F20/F21/F22** (same instruction repeated every phase): revoked/expired
service credential behavior (F19), the live entitlement cancel/re-subscribe cycle (Orders only needed static
disabled/enabled), and Platform JWT/JWKS verification specifics. Item 32 of the E2E matrix ("Platform
unavailable fails closed") cites `tests/e2e/customers-platform-unavailable.test.ts` directly rather than
re-testing — it exercises the shared `callPlatform` client, unchanged and module-agnostic, which Orders'
entitlement gate calls identically.

One real, self-caught test bug during this phase: an E2E authorization test asserted a sanity-check GET
succeeding with `platformFacingA`'s credential, but that fixture key is Na Pista's own outbound usage/event
credential (`usage.write`/`event.publish` only, no `catalog.*` scope at all) — not a "has read, lacks write"
credential. The assertion was wrong, not the API; fixed by removing the incorrect sanity-check (the actual
scope-rejection assertion it wrapped was correct from the start and remains).

## Security review
Searched for `organizationId`, `orderId`, `customerId`, `productId`, `unitPrice`, `subtotal`, `total`,
`currency`, `JWT`, `API key`, `secret`, `password` (F23 brief §45) across every new/modified file: every
`organizationId` used inside `src/modules/orders/{repository,service}.ts` is `tenant.organizationId`
(server-resolved), confirmed by direct grep with every other occurrence excluded and manually verified —
`:organizationId` appears only as a route **path** parameter, never a body field in any `.strict()` schema.
`unitPrice`/`productName`/`subtotal`/`total`/`currency` are not valid fields in `createOrderSchema`/
`addOrderItemSchema` at all — a client cannot inject them even by trying (proven directly, E2E). No secret/
password/JWT literal in any Order file, ADR, or API doc. No direct Platform DB access. No raw Postgres error
ever reaches a client response (confirmed: the insufficient-stock E2E test asserts the response body contains
no `postgres`/`constraint`/`relation` text). No PII beyond opaque ids in audit metadata.

## Known limitations
1. **`Order.currency` is a hardcoded `"AOA"` constant**, not read from a real `TenantSettings`/organization-
   currency table — that table does not exist yet (confirmed: not in `src/db/schema/`). This is F23A's own
   explicitly sanctioned interim ("use the F23A-approved current AOA configuration... without inventing a new
   settings subsystem unless absolutely required") — documented here, not silently assumed. The one line that
   changes when a real setting exists is named in `orders/service.ts`'s own `DEFAULT_CURRENCY` comment.
2. **Order→StockMovement traceability is a free-text string, not a foreign key** — inherited from ADR-032's
   own named limitation, unchanged by this phase (no Inventory schema modification was made, per the brief).
3. **No reservation/hold system** — two `DRAFT` Orders can both plan to consume the last unit of a product;
   only the first `CONFIRMED` wins (the proven `INSUFFICIENT_STOCK` guarantee applies automatically to the
   other). Explicitly out of scope (brief §21/§22), not a gap.
4. Same in-memory service-credential registry as F19-F22 — not a real secret store (unchanged, not
   re-litigated here).
5. UI login still not live-browser-tested (same Supabase test-signup constraint documented since F20).
6. No low-stock/backorder awareness at Order-creation time — a DRAFT Order can be built referencing more of a
   product than currently exists; only confirmation enforces availability (by design, ADR-032).

## Deferred decisions
Everything F23's own brief explicitly excludes (§4/§48): payments, invoices, fiscal documents, discounts/
coupons/promotions, taxes, shipping/delivery, refunds, installments, credit/receivables, supplier purchasing,
accounting/profit, multi-currency/exchange rates, stock reservations, advanced reporting/analytics,
notifications. A dedicated `SALE` StockMovement type + `orderId` FK for first-class traceability (ADR-032's
named extension path) — deferred to whenever an Inventory schema change is next justified by a real
requirement (e.g., "show me every movement caused by Order #123" reporting).

## Platform changes
None. Confirmed no `ul-platform` production code was modified — only two dev-only fixture scripts
(`f23-provision-fixtures.ts`/`f23-teardown-fixtures.ts`), same pattern as F19-F22.

## Git
**Commits:** `na-pista` (schema+migration for Order/OrderItem/Product.price, the minimal Inventory-service
transaction-passthrough refactor, repository/service/routes, authorization wiring, error classes, tests,
docs/ADRs), `na-pista-console` (Orders UI pages + Product pricing UI), `ul-platform` (F23 fixture scripts
only). **Push:** no remote configured for `na-pista`/`na-pista-console` — no push. `ul-platform` has a remote
but was not pushed without an explicit request (same posture as every prior phase).

## F24 readiness
The tenant-scoped-repository + entitlement-gate + audit/usage pattern is now proven five times across four
different relational shapes, and — for the first time — two domain services (Orders, Inventory) have proven
they can compose transactionally without either owning the other's tables. Any future module that needs to
participate in an existing domain's transaction (e.g., a future Payments module debiting a wallet balance
alongside an Order) has a concrete, working template to follow: the `externalTx`-passthrough pattern
`inventory/service.ts` now demonstrates.

## Self review (F23 brief §50)
1. **Can a client manipulate Product price?** No — `updateProduct`/`createProduct` require `products.update`/
   `products.create` permission (an authorized business decision, not an Order-time exploit); within an Order,
   `unitPrice` is not even a valid field in any Order/item schema — proven E2E (submitting it → `400
   VALIDATION_ERROR`).
2. **Can a client manipulate Order total?** No — `total`/`subtotal` are not valid fields in `createOrderSchema`
   at all; always computed server-side via SQL `SUM`/`ROUND` — proven E2E and integration.
3. **Can historical OrderItems preserve old prices?** Yes — proven with the exact Day-1/Day-2 scenario (price
   changes after order creation; the OrderItem's `unitPrice` is unaffected).
4. **Can money be represented without floating-point errors?** Yes — `numeric(14,2)` end to end, computed via
   Postgres's exact `numeric` arithmetic; proven with a real multi-item sum that would show float drift if one
   existed (it doesn't).
5. **Is currency unambiguous?** Yes — one per Order, snapshotted, never duplicated on Product or per-item.
6. **Can an Organization change its currency without changing historical Orders?** Yes by construction —
   `Order.currency` is a stored snapshot, never re-derived; not yet exercisable in practice since there is no
   real currency *setting* to change yet (known limitation #1 above), but the mechanism is correct regardless.
7. **Can Orders contain multiple currencies?** No — no per-item currency field exists to disagree.
8. **Are rounding rules deterministic?** Yes — Postgres's native `ROUND(numeric, 2)`, confirmed empirically
   (F23A) to be round-half-away-from-zero, applied once per line item, results stored not recomputed.
9. **Is quantity × price deterministic?** Yes — exact SQL `numeric` multiplication, no JS float step.
10. **Is zero-price behavior explicit?** Yes — `price: 0` is valid and distinct from `null`, proven at both
    unit (schema) and integration (a real free product orderable) levels.
11. **Is missing-price behavior explicit?** Yes — `PRODUCT_PRICE_REQUIRED`, proven integration + E2E.
12. **Is Customer requirement explicit?** Yes — nullable, anonymous Orders proven E2E.
13. **Is Order lifecycle explicit enough for F23?** Yes — full transition table implemented exactly as
    ADR-032 specified, every transition and every invalid-transition rejection proven.
14. **Is the Inventory interaction point explicit?** Yes — exactly `DRAFT → CONFIRMED` (decrease) and
    `CONFIRMED → CANCELED` (reversal), reusing `createMovement` unchanged, zero Inventory schema changes —
    confirmed by `git diff` showing no changes to `src/db/schema/inventory.ts` or
    `src/modules/inventory/repository.ts`.
15. **Are money and inventory valuation kept separate?** Yes — no `inventory.cost`/`inventory.value` anywhere;
    confirmed by code review of every file this phase touched.
16. **Is tenant isolation defined for Order and OrderItem?** Yes — proven at all three layers (application,
    HTTP, PostgreSQL composite FK).
17. **Can F24 now implement further Commerce features without reinterpreting F23's decisions?** Yes — Order/
    OrderItem/pricing/lifecycle/Inventory-boundary are all concretely implemented and tested; any future
    Payments/Tax/Discount module is a clearly additive extension (ADR-032/ADR-031's own named extension paths),
    not a redesign.

All answers supported by code/test evidence given above — marking **COMPLETE**.

## Exact next step
F24 (or the business's next priority) can build Payments, Discounts, Tax, or Fulfillment as additive extensions
of the Order/OrderItem/StockMovement shapes this phase established, or — if the business needs it sooner —
resolve the one real known limitation that blocks nothing today but matters for a second currency: standing up
a real `TenantSettings`/organization-currency table so `Order.currency` reads a genuine per-organization
setting instead of the current `DEFAULT_CURRENCY` constant.
