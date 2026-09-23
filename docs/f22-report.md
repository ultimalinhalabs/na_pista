# F22 Report — Inventory Management Vertical Slice

## Estado

**COMPLETE.** Every Definition of Done item (F22 brief §33) is proven, not asserted — see "Tests" and "Self
review" below. Inventory is now the third real business module in Na Pista (`Product → InventoryBalance →
StockMovement`), reusing every mechanism F19/F20/F21 already proved (tenant-scoped repository, local
authorization map, `catalog.enabled` entitlement, transactional audit, real Platform usage) rather than
inventing a parallel one. F18's three inventory-adjacent open decisions — OD-04 (units/fractional quantities),
OD-05 (negative stock/backorders), OD-06 (locations/warehouses) — are formally closed for this slice's scope by
ADR-027 and ADR-028.

## Scope delivered
`na_pista.inventory_balances` + `na_pista.stock_movements` (own migration, plus a `unit` column added to the
existing `products` table), tenant-scoped repository with atomic/concurrency-safe balance mutation, full
read API + the single `POST .../movements` write (no direct quantity overwrite), `.strict()` Zod validation
with precise-decimal quantity normalization, `inventory.*` permissions wired into the existing local
authorization map (with a body-dependent permission split), `catalog.enabled` entitlement reused, transactional
audit (mutation + movement + audit in one `db.transaction`, proven with a real forced-failure rollback), real
Platform usage, 12 unit + 17 integration + 19 E2E tests (48 total, inventory-specific — see "Tests" below),
Default UI pages (inventory list + per-product balance/history/movement-form) following `DESIGN.md`, 2 ADRs, API
documentation, no UL Platform production code touched.

## Inventory model (ADR-027)
`InventoryBalance { id, organizationId, productId, quantity, createdAt, updatedAt }` — one row per
`(organization, product)` (`UNIQUE(organization_id, product_id)`), lazily created on the product's first
`RECEIPT` (no zero-quantity row for every never-stocked product). `StockMovement { id, organizationId,
inventoryId, productId, type, quantity, reason?, actorType, actorId, createdAt }` — the append-only ledger
every balance change is provably derived from. Both tables use the exact composite-FK pattern ADR-021 already
established for `products → categories`: `(organization_id, product_id) → products(organization_id, id)`.

**Quantity/UOM (OD-04, closed):** `numeric(20,6)`, never a float; the API accepts a JSON number or decimal
string and always normalizes to a fixed 6-decimal string before reaching Postgres (mirrors `ul-platform`'s own
`usage_events.quantity` convention exactly). Unit of measure is a minimal fixed enum (`UNIT|KG|G|L|ML`) placed
on `Product`, not on Inventory — it is intrinsic to the product, never something that varies per inventory
record. No unit-conversion engine, no per-organization custom units.

**Locations (OD-06, closed for this slice):** deferred — one logical balance per `(Organization, Product)`,
full stop. Nothing in Na Pista's current scope demonstrates a multi-location need; the natural future extension
is additive (`location_id` column, widen the unique constraint), not a redesign.

## Stock Movement and transaction semantics (ADR-028)
**Negative stock (OD-05, closed): not allowed, no backorders.** Movement types kept intentionally small —
`RECEIPT`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT` only; no `SALE`/`RESERVATION`/`TRANSFER` (those imply Order
workflows that don't exist yet). Direction always comes from `type`, never from sign — the API only ever
accepts a positive quantity. `createMovement` (`src/modules/inventory/service.ts`) runs inside one
`db.transaction`: re-check the product's existence/archived status → apply the balance change with a single,
self-contained SQL statement (`INSERT ... ON CONFLICT DO UPDATE` for an increase; a conditional `UPDATE ...
WHERE quantity >= $delta` for a decrease, returning zero rows — never a caught error to translate — when
insufficient) → insert the movement → insert the audit event. Any failure rolls back everything.

## API
`/v1/organizations/:organizationId/inventory` (list/detail/movements, read) and
`/v1/organizations/:organizationId/inventory/:productId/movements` (the one write). Same envelope/pipeline/
conventions as Products/Categories/Customers. Full contract: [`docs/api/inventory-api.md`](api/inventory-api.md).

## Database
Real `drizzle-kit` migration (`0002_skinny_thunderbolt.sql`) adding `inventory_balances`, `stock_movements`, and
`products.unit`. Hit the same drizzle-kit FK-before-unique-index ordering bug already documented in F20's
report — manually reordered `CREATE UNIQUE INDEX`/`CREATE INDEX` before the `ALTER TABLE ... ADD CONSTRAINT`
statements, applied cleanly against real Postgres, verified with `\d` (6 tables now in the `na_pista` schema).
`CHECK` constraints (`quantity >= 0` on balances, `quantity > 0` on movements) exist as defense-in-depth under
the primary atomic-update mechanism — both proven to actually fire with a direct raw insert
(`tests/integration/inventory.test.ts`).

## Authorization
`inventory.read/create/update` added to the existing local permission map (`src/authorization/
permissions.ts`). OWNER/ADMIN/MANAGER: full read+write. STAFF: read only. **No role ever has
`inventory.delete`** — there is no lifecycle operation to delete; a mistaken movement is corrected with a
compensating movement, never erased. The permission actually checked for a write depends on the request
body's `type` (`RECEIPT` → `inventory.create`, `ADJUSTMENT_IN`/`ADJUSTMENT_OUT` → `inventory.update`) — this
required a small inline check in the route handler (after body validation, using the exact same
`roleHasPermission`/scope primitives `requireAuthorized` uses everywhere else) since `requireAuthorized`'s
existing signature only supports a route-level, not body-level, permission.

## Entitlement
Reuses `catalog.enabled` (ADR-022, unchanged) — no new Platform entitlement invented for Inventory, same
reasoning F21 already documented for Customers.

## Tenant isolation
Identical posture to Products/Categories/Customers, proven for Inventory specifically at both layers:
- **Structural (integration tests, real Postgres):** a direct insert into `inventory_balances` or
  `stock_movements` referencing a product from a different organization is rejected by the composite FK —
  proven by catching the real Postgres error and asserting on its `.cause` (drizzle-orm wraps the driver error;
  the outer message alone doesn't carry "foreign key", so assertions inspect `error.cause.message`).
- **HTTP (E2E tests, real Platform + real Na Pista):** cross-org list/GET/POST all correctly blocked (`403` no
  membership/wrong credential, `404` real membership/wrong resource — `PRODUCT_NOT_FOUND`, never the row).

## Concurrency (F22 brief §32 — the mandatory proof)
`tests/integration/inventory.test.ts` fires genuinely concurrent database transactions (via
`Promise.allSettled` over independently-opened `db.transaction` calls, not sequential `await`s) against a
known starting balance:

| Scenario | Starting balance | Concurrent requests | Result |
|---|---|---|---|
| 2-way race | 10 | Two `ADJUSTMENT_OUT = 7` | Exactly 1 succeeded, 1 rejected with `INSUFFICIENT_STOCK`. Final balance: **3**. |
| 5-way race | 10 | Five `ADJUSTMENT_OUT = 3` | Exactly 3 succeeded, 2 rejected with `INSUFFICIENT_STOCK`. Final balance: **1** (10 − 3×3). |

Both runs measured against the real Postgres instance this project uses (not mocked, not sequential). In every
run: the balance never went negative, no lost update occurred, and the count of `ADJUSTMENT_OUT` movement rows
matched exactly the number of transactions that actually succeeded — no orphaned movement from a loser. This
is the direct, evidence-based proof ADR-028 defers to rather than restating.

## Audit
Same-transaction as the mutation (ADR-023/ADR-028). **Proven by causing a real audit failure** (a genuine
Postgres `NOT NULL` violation on `audit_events.action`) inside the same transaction as a balance increase +
movement insert, and confirming afterward that **both** the balance change and the movement row do not exist
(`tests/integration/inventory.test.ts`) — proving the whole chain rolls back together, not just the movement.

## Usage
`api_requests` meter (F20/F21's established, real, Platform-seeded choice) — no fake `inventory.movement`
meter invented. Proven live: a real stock movement measurably increases the Platform's own recorded usage;
a usage-write failure (no registered credential) never blocks the movement itself (`platform/usage.ts` catches
and logs, never throws — unchanged mechanism).

## UI
`na-pista-console`: `/o/[organizationId]/inventory` (list: product, quantity, unit, IN_STOCK/OUT_OF_STOCK
badge, last-updated; `zeroStock` filter) and `/o/[organizationId]/inventory/[productId]` (current quantity,
movement-history table, and a movement form gated by `inventory.create`/`inventory.update` offering exactly
three actions: Receive stock, Adjustment increase, Adjustment decrease — quantity + optional reason fields,
**no direct quantity field**, matching the API's own no-PATCH contract). Follows `DESIGN.md` (dark
premium palette, gold reserved for the primary action, semantic `badge-success`/`badge-warning` for
in-stock/out-of-stock) — no new visual patterns introduced. Archived products show their balance/history
read-only, with the movement form hidden entirely rather than shown-then-rejected. `build`/`lint`/`typecheck`
all pass.

## Tests

| Layer | Inventory-specific | Result |
|---|---|---|
| Unit | 12 | 12 pass |
| Integration (real Postgres) | 17 | 17 pass |
| E2E (real Platform + real Na Pista + real Postgres) | 19 | 19 pass |
| **Inventory total** | **48** | **48 pass, 0 fail** |

`na-pista`'s full root suite in the same runs (Inventory + F20/F21's unchanged Products/Categories/Customers
code, one shared `test:unit`/`test:integration`/`test:e2e` invocation): **39 unit + 25 integration + 63 E2E =
127 tests.** F19's spike suite was not re-run this session (unchanged, separate directory/command) — consistent
with F20/F21's own reports, its last recorded result is not merged into the 127 above.

**Deliberately not duplicated from F19/F20/F21** (same instruction repeated each phase): revoked/expired
service credential behavior (8 dedicated F19 tests, unchanged code path), the live entitlement cancel/
re-subscribe cycle (Inventory only needed static disabled/enabled), and Platform JWT/JWKS verification
specifics. Each E2E file that touches these says explicitly, in its own header comment, what it is and isn't
re-proving.

A fixture-mismatch bug was caught and fixed before any test ran against real infrastructure: the initial
`f22-provision-fixtures.ts` only minted a service credential for org A, but the tenant-isolation and usage E2E
tests need org B to have its own registered credential too (entitlement checks call the Platform using a
per-organization credential, not the human's JWT) — added `platformFacingB` to the fixture set and
`registerF22Credentials` before any suite ran, mirroring what F21's fixtures already did.

Two assertions in the first integration-test draft checked the wrong error surface: `assert.rejects(fn,
/foreign key|violat/i)` matches against drizzle-orm's own outer wrapper message ("Failed query: ..."), which
does not contain those words — the real Postgres error text lives on `error.cause`. Both the composite-FK and
CHECK-constraint tests were rewritten to catch the error and assert on `error.cause.message` directly; re-run
confirmed both constraints do fire as designed (this was a test-assertion bug, not a schema bug — the FK/CHECK
constraints themselves were correct on the first migration).

## Security review
Searched for `organizationId`, `tenant`, `productId`, `inventoryId`, `service credential`, `JWT`, `API key`,
`secret`, `password`, `quantity`, `customer`, `order` (F22 brief §36) across every new/modified file in this
phase: every `organizationId` used inside `src/modules/inventory/{repository,service}.ts` is
`tenant.organizationId` (server-resolved from the authenticated request), never taken from the request body —
confirmed by direct code inspection (`grep -rn "organizationId" src/modules/inventory/`, every occurrence
traced). No secret/password/JWT literal in any inventory file, ADR, or the API doc. No direct Platform DB
access. No tenant/entitlement/permission bypass (all proven above). `quantity` never reaches Postgres as a raw
JS number/float — always a validated, normalized fixed-decimal string. No `order`-shaped concept exists in this
slice (deliberately out of scope).

## Known limitations
1. Same in-memory service-credential registry as F19/F20/F21 — not a real secret store (unchanged, not
   re-litigated here).
2. No low-stock threshold/alerting — no per-product minimum-stock field exists yet; `zeroStock` (well-defined,
   no threshold needed) is offered instead of a speculative `lowStock` filter (F22 brief §16).
3. `ADJUSTMENT_OUT` against "no balance row at all" and "genuinely insufficient balance" both return the same
   `409 INSUFFICIENT_STOCK` — deliberately not distinguished (ADR-028); a client gains nothing from telling
   them apart.
4. UI login still not live-browser-tested (same Supabase test-signup constraint documented since F20).
5. The inline body-dependent permission check in `routes.ts`'s POST handler is the one place this slice departs
   from calling `requireAuthorized` as pure middleware — documented and justified (see "Authorization" above),
   not a hidden second authorization mechanism, but worth flagging as the one place a future refactor of
   `requireAuthorized` to accept a body-derived permission would simplify.

## Deferred decisions
Multi-location/warehouse inventory (OD-06, deferred, not closed shut — see ADR-027's additive extension path).
A unit-conversion engine or per-organization custom units — no requirement justifies it yet. Low-stock
alerting/notifications. Batch/lot tracking, expiry dates, serial numbers. Supplier/purchase-order integration,
cost/valuation (FIFO/weighted average). How a future Orders module reserves/fulfills stock against this same
ledger — intentionally undecided; Inventory was built to not preclude it (ADR-028 "Consequences"), not to
pre-guess its shape.

## Platform changes
None. Confirmed no `ul-platform` production code was modified — only two dev-only fixture scripts
(`f22-provision-fixtures.ts`/`f22-teardown-fixtures.ts`), same pattern as F19/F20/F21.

## Git
**Commits:** `na-pista` (schema+migration, repository/service/routes, authorization wiring, error classes,
tests, docs/ADRs), `na-pista-console` (Inventory UI pages), `ul-platform` (F22 fixture scripts only).
**Push:** no remote configured for `na-pista`/`na-pista-console` — no push. `ul-platform` has a remote but was
not pushed without an explicit request (same posture as F18/F19/F20/F21).

## F23 readiness
The tenant-scoped-repository + entitlement-gate + audit/usage pattern is now proven four times (Categories,
Products, Customers, Inventory) across three different relational shapes (composite FK, no FK, and now a
composite FK feeding an atomic-mutation ledger). The atomic-update concurrency pattern established here
(single conditional `UPDATE`/`INSERT ON CONFLICT`, no `SELECT ... FOR UPDATE`) is a template any future module
needing race-safe numeric state (e.g., a future Orders module reserving stock) can reuse directly rather than
re-deriving.

## Self review (F22 brief §33)
1. Inventory belongs exclusively to one Organization — yes, `organization_id NOT NULL` on both tables, proven
   (integration + E2E).
2. `organizationId` cannot be manipulated — yes, never accepted from the request body (`.strict()` schemas
   don't even have the field); the URL value is always validated against real membership/credential first.
3. `productId`/`inventoryId` cannot be manipulated across tenants — yes, cross-tenant product id resolves
   `404 PRODUCT_NOT_FOUND`, never the row; composite FK makes a cross-tenant `inventory_balances`/
   `stock_movements` row structurally impossible even at the database layer.
4. Authorization enforced server-side — yes, proven for OWNER/ADMIN/MANAGER/STAFF, including the body-dependent
   RECEIPT-vs-ADJUSTMENT permission split.
5. Entitlement enforced server-side — yes, `requireCapability`, proven disabled and enabled.
6. Quantity is never a floating-point value on the way to persistence — yes, `numeric(20,6)` +
   normalize-to-string before the query; proven via decimal-string round-trip tests.
7. Negative stock is impossible — yes (OD-05/ADR-028), proven at three levels: the conditional `UPDATE`'s
   `WHERE` guard (primary), the `CHECK` constraint (defense in depth), and Zod rejecting non-positive input
   (never even reaches the database).
8. Concurrent decreases never lose an update or go negative — yes, **proven with real concurrent Postgres
   transactions**, not asserted (see "Concurrency" above — 2-way and 5-way races both measured, both correct).
9. Audit happens atomically with the balance/movement change — yes, proven with a **real forced failure and
   observed rollback** of both the movement and the balance change together.
10. Usage uses a real existing meter — yes, `api_requests`, proven to really increase on the Platform.
11. There is no way to overwrite a quantity directly — yes, no `PATCH` route exists on the balance resource;
    confirmed by a dedicated E2E test hitting that path with `PATCH` and getting a route-not-found `404`.
12. An archived product's inventory stays fully readable — yes, balance/history both proven still-readable
    after archive, with the create-movement form hidden in the UI and the API returning `409 PRODUCT_ARCHIVED`
    for any attempted write.
13. API works without the UI — yes, all 48 inventory-specific tests (and 127/127 for the whole `na-pista`
    suite) never touch the UI.
14. An independent custom UI could consume the API — yes, by construction (same posture as F20's ADR-008).
15. No direct Platform DB access — yes, confirmed by code review (only `PLATFORM_API_URL` HTTP calls exist).
16. No secrets in the frontend — yes, only `NEXT_PUBLIC_*` values.
17. Cross-tenant access fails — yes, both structurally (FK) and over HTTP (403/404).
18. Entitlement-off fails — yes.
19. Entitlement-on succeeds — yes.
20. Service authentication works — yes (sufficient `catalog.write` scope succeeds; insufficient scope blocked).
21. Human authentication works — yes (OWNER/ADMIN/MANAGER/STAFF all exercised).
22. Platform failure fails closed — yes, `UpstreamUnavailableError`/`503`, proven (entitlement test, no
    registered credential for org C).
23. No product-specific tables/business logic leaked into UL Platform — yes; nothing in `ul-platform`
    production code changed, confirmed by `git status`/`git diff` on that repository.
24. Unit/locations decisions are documented, not silently invented — yes, ADR-027 closes both with explicit
    reasoning and an additive extension path for locations.
25. Still limited to Inventory Management — yes: no Orders, Payments, Warehouses/multi-location, Suppliers,
    Variants, or any capability beyond what §2's scope stated.
