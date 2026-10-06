# F30 — Audit (Phase 0, before any code)

Branch `f30-integration-contract`, cut from `f29a-platform-credential-persistence` @ `ce50839` (F29A is not yet
merged into `main`; F30 depends on its credential store). Everything below was read from source or measured
against the running app — nothing is taken from older plans.

## 1. Endpoint inventory

57 routes: `GET /v1/health` (unauthenticated) + 56 authenticated, all under
`/v1/organizations/:organizationId/…`. Every authenticated route has the same chain:
`authenticate` → `requireTenantContext` → `requireCapability("catalog.enabled")` → `requireAuthorized(permission, scope)` → handler.

| Module | Method + path (after `/v1/organizations/:organizationId`) | Permission (human) | Scope (service) |
| --- | --- | --- | --- |
| Categories | `POST /categories` · `GET /categories` · `GET/PATCH/DELETE /categories/:categoryId` | `categories.create/read/update/delete` | `catalog.write`/`catalog.read` |
| Products | `POST /products` · `GET /products` · `GET/PATCH/DELETE /products/:productId` | `products.*` | idem |
| Customers | `POST /customers` · `GET /customers` · `GET/PATCH/DELETE /customers/:customerId` | `customers.*` | idem |
| Inventory | `GET /inventory` · `GET /inventory/:productId` · `GET /inventory/:productId/movements` | `inventory.read` | `catalog.read` |
| | `POST /inventory/:productId/movements` | `inventory.create` (RECEIPT) / `inventory.update` (ADJUSTMENT_*) — decided **in the handler** from the body | `catalog.write` |
| Orders | `POST /orders` · `GET /orders` · `GET/PATCH /orders/:orderId` · `POST /orders/:orderId/items` · `PATCH/DELETE /orders/:orderId/items/:itemId` · `POST /orders/:orderId/{confirm,cancel,complete}` | `orders.create/read/update` | idem |
| Services | `POST /services` · `GET /services` · `GET/PATCH /services/:serviceId` | `services.create/read/update` | idem |
| Professionals | `POST /professionals` · `GET /professionals` · `GET/PATCH /professionals/:professionalId` · `GET /professionals/:id/services` · `POST/DELETE /professionals/:id/services/:serviceId` | `professionals.create/read/update` | idem |
| Scheduling | `GET/PUT /professionals/:id/schedule` · `GET/POST /professionals/:id/schedule/exceptions` · `DELETE …/exceptions/:exceptionId` · `GET /professionals/:id/availability` | `scheduling.read/create/update` | idem |
| Settings | `GET/PUT /settings` | `scheduling.read/update` | idem |
| Appointments | `POST /appointments` · `GET /appointments` · `GET/PATCH /appointments/:appointmentId` · `POST …/{cancel,complete,no-show}` · `GET /professionals/:id/bookable-slots` | `appointments.create/read/update` | idem |

No route exists for audit, credential status, webhooks or an OpenAPI document.

## 2. Authentication

`Authorization: Bearer <token>` on every `/v1` route except health (`middleware/authenticate.ts`).
- `ulk_…` → **service credential**, introspected by the Platform (`GET /v1/service/me`, 15 s cache). Yields
  `organizationId`, `application`, `scopes`.
- Anything else → **Supabase user JWT**: local shape/expiry pre-check only, then identity + memberships from the
  Platform (`GET /v1/me`). Na Pista never verifies a secret itself (ADR-012/016).
- Failures: `401 UNAUTHORIZED` ("Missing bearer token" / "Malformed or expired token" / Platform rejection).

## 3. Authorization

- **Tenant:** `:organizationId` becomes `req.tenant` only if (human) the user has an ACTIVE membership in it, or
  (service) the credential's own organization equals it. Otherwise `403 FORBIDDEN`. Every repository query also
  filters by `organization_id` (`assertTenant`).
- **Capability:** `catalog.enabled` entitlement (Platform, 10 s cache) → else `403 ENTITLEMENT_REQUIRED`. It is the
  **only** entitlement; it gates all of Na Pista.
- **Permission:** `authorization/permissions.ts` maps Platform role keys to Na Pista permissions. OWNER = ADMIN
  (everything incl. `*.delete`); MANAGER = all except `products/categories/customers.delete`; STAFF = `*.read` only.
- **Scope:** service credentials need `catalog.read` (reads) / `catalog.write` (mutations).
- One documented exception: inventory movements choose the permission from the body, using the same primitives.

## 4. Success envelope

`shared/response.ts` `ok()` → `{ "data": <payload> }`, status 200/201. Lists return `{ "data": [ … ] }` with **no
metadata**. `X-Request-ID` echoed (validated `^[A-Za-z0-9._-]{1,128}$`, else generated). Representative
non-uniform payloads (all deliberate, all relied on by the Console): `GET /settings` → `data: null` when no timezone
is configured; inventory movement `POST` → `{ balance, movement }`; `DELETE …/services/:serviceId` and
`DELETE …/exceptions/:id` → `{ removed: true }`; archive `DELETE`s return the archived resource.

## 5. Error envelope

`{ "error": { "code", "message" } }` via `middleware/errorHandler.ts`. Codes in use: `VALIDATION_ERROR 400`,
`BOOKING_HORIZON_EXCEEDED 400`, `UNAUTHORIZED 401`, `FORBIDDEN 403`, `ENTITLEMENT_REQUIRED 403`, `NOT_FOUND 404`,
`PRODUCT_NOT_FOUND`/`INVENTORY_NOT_FOUND`/`ORDER_NOT_FOUND`/`APPOINTMENT_NOT_FOUND 404`, `CONFLICT 409` (+ unique /
exclusion violations), `LIMIT_EXCEEDED`, `INSUFFICIENT_STOCK`, `PRODUCT_ARCHIVED`, `PRODUCT_PRICE_REQUIRED`,
`CUSTOMER_ARCHIVED`, `INVALID_ORDER_STATE`, `EMPTY_ORDER`, `PROFESSIONAL_ARCHIVED`, `SERVICE_ARCHIVED`,
`TIMEZONE_NOT_CONFIGURED`, `APPOINTMENT_CONFLICT`, `APPOINTMENT_OUTSIDE_AVAILABILITY`, `INVALID_APPOINTMENT_STATE`,
`APPOINTMENT_COMPLETION_TOO_EARLY`, `APPOINTMENT_NO_SHOW_TOO_EARLY` (409), `UPSTREAM_UNAVAILABLE 503`,
`INTERNAL_ERROR 500`. No SQL, stack or driver detail reaches a response (driver code is logged server-side only).
Zod failures always say only "Invalid request payload" — no field information.

**Measured against the running app (defects):**

| Probe | Observed | Expected |
| --- | --- | --- |
| Malformed JSON body | **500 `INTERNAL_ERROR`** | 400 `VALIDATION_ERROR` |
| Same, response headers | **no `X-Request-ID`** (`express.json()` runs before `requestId`) | always present |
| Unmatched path outside `/v1`, or authenticated unmatched path under `/v1` | **Express HTML 404 page** | JSON `404 NOT_FOUND` |

No rate limiting exists in Na Pista (`api-boundary.md` mentions `middleware/rateLimit.ts`; the file does not exist).

## 6. Collection endpoints

| Endpoint | Default / max `limit` | Order | Deterministic? |
| --- | --- | --- | --- |
| `GET /categories` | 50 / 100 | `createdAt desc` | **no** (no tiebreak) |
| `GET /products` | 50 / 100 | `createdAt desc` | **no** |
| `GET /customers` | 50 / 100 | `createdAt desc` | **no** |
| `GET /services` | 50 / 100 | `createdAt desc` | **no** |
| `GET /professionals` | 50 / 100 | `createdAt desc` | **no** |
| `GET /orders` | 50 / 100 | `createdAt desc` | **no** |
| `GET /inventory` | 50 / 100 | `updatedAt desc` | **no** |
| `GET /inventory/:productId/movements` | 50 / 100 | `createdAt desc` | **no** |
| `GET /appointments` (`from`/`to` required, ≤ 31 days) | 200 / 500 | `startAt asc, id asc` | yes |
| `GET /professionals/:id/services` | **unbounded** | `associatedAt desc` | no — bounded by the org's service count |
| `GET /professionals/:id/schedule` | unbounded | `dayOfWeek, startLocalTime` | rules are a small weekly set (validated) |
| `GET /professionals/:id/schedule/exceptions` | **unbounded** | `date, startLocalTime` | grows with history — the one genuinely unbounded list |
| `GET …/availability`, `GET …/bookable-slots` | computed, range-bounded (`from/to`, one `date`) | — | not collections of stored rows |

## 7. Pagination

None. Every list silently truncates at `limit`; the client cannot tell whether more rows exist and cannot fetch
them. The Console compensates with a "first 100 results" notice (`ResultLimitNotice`) and derives dashboard counts
from list length (e.g. "Produtos sem stock" is wrong above 100). All lists run at the database (`LIMIT`), none in
memory. **Conflict:** accepted ADR-005 and `api-boundary.md` promise cursor pagination (`page.nextCursor`) — never
implemented. The UL Platform's own audit log uses keyset cursors (`{ items, nextCursor }`).

## 8. Filtering

Strict Zod query schemas (`.strict()`: unknown parameters → 400). Existing: `status` (all catalog lists, orders,
appointments), `q` (case-insensitive name substring: products, customers, services, professionals), `categoryId`
(products), `customerId` (orders, appointments), `serviceId` (professionals, appointments), `professionalId`
(appointments), `from`/`to` (appointments, availability), `zeroStock` (inventory).
**Defect:** `zeroStock` uses `z.coerce.boolean()`, so `zeroStock=false` means **true**. (Console only sends `true`.)

## 9. Sorting

None anywhere. Clients cannot choose order; defaults above.

## 10. Webhooks

- Na Pista has **no webhook code and publishes no events** (no call to the Platform's `POST /v1/organizations/:id/events`;
  ADR-050's outbox is "Accepted — no production code yet").
- The **UL Platform owns webhooks**: `POST/GET /v1/organizations/:id/webhooks`, `GET …/webhooks/:id`,
  `POST …/:id/revoke`, `POST …/:id/test`. Human-only; `webhook.read` (OWNER+ADMIN) / `webhook.manage` (OWNER).
  Metadata: `id, application, organizationId, status, createdAt, revokedAt, eventTypes` — **no URL, no secret**
  (secret returned once, on creation).
- Deliveries are persisted (`webhook_deliveries`: event, status, attempt, responseStatus, timestamps) but **no
  Platform API reads them**.
- The Console already manages webhooks by calling the Platform directly (F29 integration centre).

## 11. Audit

`audit_events` (Na Pista's business audit, ADR-023): `id, organizationId, actorType (user|service), actorId,
action, resourceType, resourceId, metadata (jsonb), requestId, createdAt`; append-only; written in the same
transaction as the mutation. Indexes `(org, createdAt)`, `(org, resourceType, resourceId)`. **No read API.**
Metadata is written by Na Pista code only; F29A's credential events carry metadata only (proven by test).

## 12. Credential status

F29A: `getPlatformCredentialStatus(organizationId)` exists (`modules/platformCredentials/service.ts`), returns
`toStatus(row)`; **no route**. No permission covers integration metadata today.

## 13. Existing documentation

`docs/api/` has 8 module references (products incl. categories, customers, inventory, orders, services,
professionals, scheduling incl. settings, appointments) — prose, hand-written, no machine-readable contract.
`api-boundary.md`, ADR-005/008, `integration-flow.md`, `authorization.md`, `audit.md`, `usage.md`, `events.md`.
No OpenAPI, no quickstart, no cross-cutting docs (auth, errors, pagination…). `api-boundary.md` describes several
things that do not exist (cursor pagination, `?sort=`, `Idempotency-Key`, `/v1/health/ready`, rate limiting).

## 14. Inconsistencies

1. Lists: no pagination metadata; silent truncation (§7). 2. Non-deterministic order on 8 lists (§6).
3. `zeroStock=false` ⇒ true (§8). 4. Malformed JSON → 500; unmatched routes → HTML; missing `X-Request-ID` on
parse errors (§5). 5. Validation errors carry no field information. 6. Appointments' list defaults (200/500)
differ from every other list (50/100) — justified by a bounded calendar range; keep, document.
7. Settings uses `scheduling.*` permissions (documented ADR-039 choice; keep). 8. Docs promise unimplemented
features (§13). 9. One unbounded growing list: schedule exceptions.

## 15. Potential breaking changes (to avoid or gate by ADR)

| Change | Risk | Plan |
| --- | --- | --- |
| Adding `pagination` beside `data` on lists | none for clients reading `data` (Console reads only `json.data`) | additive (ADR) |
| Replacing `limit` with `pageSize` | **breaks** Console + any client sending `limit` | keep `limit` as accepted alias |
| Changing default ordering (adding `id` tiebreak) | none — same primary order, ties become stable | do it |
| `zeroStock` strict boolean | `zeroStock=false` changes from "only zero" to "all" — a bug fix; `1`/`yes` would start failing (400) | ADR + accept `true`/`false` only |
| Malformed JSON 500 → 400; HTML 404 → JSON 404 | status/content-type change for already-failing requests | fix (no successful flow changes) |
| Adding `error.details` | additive | ADR |
| Paginating `schedule/exceptions` / `professionals/:id/services` | changing `data` from full list to first page would silently hide rows from the Console | **do not** paginate; document as bounded sub-collections, add range filter only if needed |

## 16. Recommended order

F30.0 ADRs (pagination+envelope, filtering/sorting, error contract, OpenAPI source of truth, webhook visibility,
audit read, credential status) → F30.1 error-contract fixes + OpenAPI foundation (generated from the existing Zod
schemas, served and committed, route-coverage test) → F30.2 pagination → F30.3 filtering/sorting → F30.4 credential
status → F30.5 audit read → F30.6 webhook visibility (documentation of the Platform contract; no Na Pista proxy) →
F30.7 docs + quickstart + examples → F30.8 Console validation → F30.9 full regression.
