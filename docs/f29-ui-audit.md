# F29 — Na Pista Console UI Audit (Phase 0)

Audit of `na-pista-console` at `273285a` (+ F28B working changes) against the real backend contracts of `na-pista`
(`db8a473`/`c8c76b9` + F28B) and `ul-platform` (`788a4f1`). **Code was taken as the source of truth**; every contract
claim below was verified in source, not in documentation.

## 1. Existing pages

| Route | Purpose | Notes |
|---|---|---|
| `/login` | Supabase email/password sign-in | no "session expired" message path; no redirect-back |
| `/` | list of the user's organizations | acts as org picker; each card links to `/o/:org/products` (no overview) |
| `/o/:org/*` layout | membership gate + horizontal top bar with 9 nav links + role badge | no sidebar, no breadcrumb, no org switcher, no user menu/sign-out (sign-out only on `/`) |
| `products`, `products/:id` | list (search, status, category), inline create; detail edit/archive/price | |
| `categories` | list + inline create/edit/archive | |
| `customers`, `customers/:id` | list (search, status), inline create; detail edit/archive + F27 "Marcações" | |
| `inventory`, `inventory/:productId` | balances; product movements, receive/adjust | |
| `orders`, `orders/:id` | list (status); detail items/confirm/complete/cancel | largest pre-F27 page |
| `services`, `services/:id` | list (search, status), inline create; detail edit/archive/reactivate | no "associated professionals" on the service detail |
| `professionals`, `professionals/:id` | list; detail (599 lines): profile, services, weekly schedule, exceptions, availability, appointments | scheduling lives inside the professional page |
| `appointments`, `appointments/new`, `appointments/:id` | day view, create flow, detail (reschedule/cancel/complete/no-show) | F27/F28B, the most recent UX |
| `settings` | organization timezone | only setting that exists in Na Pista |

## 2. Backend capabilities and their UI representation

### Na Pista API (`/v1/organizations/:org/…`)

| Module | Endpoints (verified) | UI today |
|---|---|---|
| Products | list(q,status,categoryId,limit≤100) / create / get / patch / archive(DELETE) / price | ✅ |
| Categories | list / create / patch / archive | ✅ |
| Customers | list(q,status,limit≤100) / create / get / patch / archive | ✅ |
| Inventory | balances list / product balance / movements list / create movement (RECEIPT, ADJUSTMENT_IN/OUT) | ✅ |
| Orders | list(status,customerId,limit≤100) / create / get / patch / items CRUD / confirm / cancel / complete | ✅ |
| Services | list(q,status) / create / get / patch (incl. status) | ✅ (no professionals relationship view) |
| Professionals | list(q,status,serviceId) / create / get / patch / services association CRUD | ✅ |
| Scheduling | settings (timezone) / weekly rules PUT / exceptions CRUD / availability | ✅ inside professional detail + settings |
| Appointments | list (bounded) / create / get / patch / cancel / complete / no-show / bookable-slots | ✅ |
| Audit (business) | **no read endpoint** (write-only `audit_events`) | ❌ — cannot be represented |

### UL Platform API consumed by a signed-in member (verified routes + seed role permissions)

| Capability | Route | OWNER | ADMIN | MANAGER | STAFF | UI today |
|---|---|---|---|---|---|---|
| Identity & memberships | `GET /me` | ✅ | ✅ | ✅ | ✅ | used by session |
| Organization | `GET/PATCH /organizations/:id` | r/w | r/w | r | r | ❌ |
| Team (memberships) | `GET/POST/PATCH/DELETE /organizations/:id/memberships` | r/w | r/w | r | r | ❌ |
| API keys (credentials) | `GET/POST /organizations/:id/api-keys`, `POST …/:keyId/revoke` | manage+read | read | — | — | ❌ |
| Service scopes catalog | `GET /applications/NA_PISTA/service-scopes` | any authenticated | | | | ❌ |
| Environments & endpoints | `GET /applications/NA_PISTA/environments[/…/endpoints]` | any authenticated (manage = platform admins) | | | | ❌ |
| Webhooks | `GET/POST /organizations/:id/webhooks`, `…/:id/revoke`, `…/:id/test` | manage+read | read | — | — | ❌ |
| Subscriptions / entitlements / usage | `GET …/subscriptions`, `…/applications/NA_PISTA/entitlements`, `…/usage[/:meter]` | ✅ | ✅ | ✅ | — | ❌ |

Contract facts that constrain honest UX:
- API keys have **no `lastUsedAt`** (explicitly omitted in the Platform schema) and **no environment** — keys are per
  organization + application, `ACTIVE|REVOKED`, optional `expiresAt`; the secret is returned only on creation.
- Webhook **deliveries are recorded but not readable** (no route lists `webhook_deliveries`); only the synchronous
  `/test` result is observable.
- Na Pista **publishes no events yet** (Outbox is F28D, not implemented) — a webhook subscribed to Na Pista event types
  would currently only ever receive `/test` deliveries.
- NA_PISTA environments are `production` + `staging` (Platform seed); only staging has an (illustrative `.example`)
  API endpoint registered.
- No discovery/capabilities endpoint in Na Pista; entitlement state is only observable via `403 ENTITLEMENT_REQUIRED`
  (or Platform entitlements, which STAFF cannot read).
- No Platform or Na Pista **audit read** endpoint exists (Platform has `audit.read` permission, no route).
- No pagination beyond `limit ≤ 100` (appointments ≤ 500) — no offset/cursor.
- No stock thresholds/reorder levels exist.

## 3. Modules / capabilities without visual representation

Organization details, Team (members & roles), Credentials (API keys), Service scopes, Environments/endpoints, Webhooks,
API documentation, Subscription/entitlement/usage visibility, Overview. (Business audit history cannot be represented
— no API.)

## 4. Partially represented

- Services ↔ Professionals: the service detail does not show which professionals perform it (API supports
  `GET /professionals?serviceId=`).
- Scheduling is only reachable per professional; no organization-level entry point.
- Entitlement denial is handled on 4 list pages only (products, orders, services, professionals); other pages show a
  generic error.
- Order/Product money is rendered as raw decimal strings (`10000.00 AOA`), no locale formatting.
- Status values rendered raw in English (`ACTIVE`, `ARCHIVED`, `DRAFT`, `CONFIRMED`) outside appointments.

## 5. UX inconsistencies

| Area | Finding |
|---|---|
| Page structure | every list page composes its own toolbar/title/create button with inline styles; no shared page header |
| Create flows | inline forms toggled inside list pages (products, customers, services, professionals, categories); appointments use a dedicated page |
| Destructive actions | archive/cancel/revoke-style actions have **no confirmation** anywhere except appointment cancel (inline form) |
| Feedback | no toast/success feedback on most mutations (only "Guardado." in two places) |
| Loading | text "A carregar…" everywhere; no skeletons; buttons show "A criar…/A guardar…" inconsistently |
| Errors | 5+ private `ErrorBanner` variants with different wording; 401 handled only on products; request-id shown inconsistently |
| Empty states | plain text in `.empty-state`; no call-to-action |
| Permissions | `roleCan` used inconsistently: some pages disable fields, some hide buttons; inventory list never checks |
| Navigation | 9 flat top-bar links (overflow on narrow screens), active match via `pathname.includes`, no breadcrumb, no org switcher, sign-out only on `/` |
| Responsiveness | fixed-width tables without horizontal scroll containers; toolbars wrap unpredictably; no mobile nav |
| Truncation | lists silently truncate at the API default (50) with no indication |
| Keyboard | no command menu/shortcuts; focus styles exist on inputs only |

## 6. API client inconsistencies

- `lib/api/*` modules are thin and consistent (`callNaPista`), but `platformClient.ts` only implements `GET /me` —
  every Platform call needed for F29 must follow the same `ApiError` convention (it currently returns `null` on error).
- No list call passes `limit`; truncation is invisible.
- `callNaPista` on 401 throws `UNAUTHORIZED` but nothing redirects to login.

## 7. Component debt & duplication

- Duplicated: `ErrorBanner` (products/services/professionals/orders/customers), status-badge logic (per page),
  page toolbars, inline create forms, "request reference" block, date formatting (F27 has `lib/datetime.ts`; older
  pages print raw ISO strings).
- Reusable foundations already present: CSS tokens + utility classes in `globals.css`/`DESIGN.md`, `lib/permissions.ts`
  (UX mirror), `lib/appointments/components.tsx` (ErrorNotice, TimezoneMissing, AppointmentsTable, SlotPicker,
  AppointmentsSection), `lib/appointments/messages.ts` (code → pt-PT message map — the right pattern, but appointment-only).

## 8. Reusable patterns to consolidate

Code→message error mapping (generalize `messages.ts`), `ErrorNotice` with request reference, `useOrganizationTimezone`,
`AppointmentsSection` as the "related resources" pattern, `roleCan` UX gating, status badge mapping.

## 9. Consequences for F29 scope (honesty constraints)

1. Credentials: list/create/revoke with one-time secret — **yes** (real API). "Last used" and per-environment keys —
   **no** (not in the contract; shown as not available, not faked).
2. Environments: read-only display of the NA_PISTA environments/endpoints the Platform declares + which API base URL
   this Console instance targets — **no** environment management (platform-admin only).
3. Webhooks: list/create/revoke/test — **yes**; delivery history/failures — **no** (not readable); banner stating Na
   Pista does not publish business events yet.
4. Overview: recent orders, today's appointments, zero-stock products, counts from list endpoints (bounded) — **no**
   activity feed (no audit read API), no invented KPIs.
5. Pagination: "showing N (API maximum 100) — refine filters" indicator instead of fake page numbers.
6. API documentation: a curated catalog derived from the real routes/schemas/`docs/api/*.md` (no machine-readable
   OpenAPI exists — recorded as a gap with a proposed backend change).
7. Team: members list (+ role changes for OWNER/ADMIN via the real memberships API).
