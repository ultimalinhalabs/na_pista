# F29 — Na Pista Console Experience & Integration Readiness

Status: **complete, with documented backend gaps** (none of them changed silently).

Repos touched: `na-pista-console` (the product UI), `na-pista` (docs + dev-only
manual-validation scripts — **no `src/` change**), `ul-platform` (dev-only
manual-validation scripts — **no production change**).

Companion documents: `docs/f29-ui-audit.md` (Phase 0 audit),
`docs/manual-validation.md` (how to validate by hand), and
`na-pista-console/DESIGN.md` §7.1 (component contracts).

---

## 1. Audit (Phase 0)

`docs/f29-ui-audit.md` recorded, before any change, every existing page, the
Na Pista and UL Platform capabilities per role (verified in source, not in
docs), what had no UI, what was partial, UX/API-client inconsistencies and
component debt. Its §9 "honesty constraints" fixed the rules applied
throughout: no invented metrics, scopes, pages or data; no fake pagination;
nothing a backend does not provide.

## 2. Information architecture

`lib/navigation.ts` — one source for the sidebar, breadcrumbs, command menu
and tests:

| Group | Items |
|---|---|
| Visão geral | Overview |
| Operação | Pedidos, Marcações, Clientes, Inventário |
| Catálogo | Produtos, Categorias, Serviços, Profissionais |
| Agenda | Horários e disponibilidade (hub) |
| Integrações | API, Credenciais, Ambientes, Webhooks, Documentação |
| Definições | Organização, Equipa, Permissões |

Items are filtered by the role mirror (`roleCan` / `platformRoleCan`) — UX
only; both backends still enforce every permission.

## 3. Design system

Tokens unchanged (`DESIGN.md` §3–§6). New React layer, documented in
`DESIGN.md` §7.1: `components/ui/*` (Button, Form/Field, Feedback — Alert,
EmptyState, Skeleton, ErrorNotice, ModuleUnavailable, PermissionDenied,
ResultLimitNotice —, Overlay — Modal, ConfirmDialog, Drawer —, Menu, Toast,
Data — Badge, DataTable, Stat, Timeline, DetailList, CopyButton —, Tabs),
`components/patterns/*` (PageHeader, ResourceHeader, Breadcrumb, Section,
FilterBar, ListPage, StatusFilter, DetailGuard) and `components/shell/*`.
Shared logic: `lib/useAsync.ts` (stale-response-safe fetching),
`lib/status.ts` (pt-PT status vocabulary), `lib/errors.ts` (error mapping),
`lib/format.ts` (`formatMoney` string-based, `displayQuantity`).

## 4. App shell

`AppShell`: grouped sidebar with active item, organization switcher (the
user's real memberships), environment indicator derived from the API URL
("Local"/"Staging"; nothing shown for production — never assumed), user menu
(email, sign out), command menu (Ctrl/⌘+K: pages + role-permitted create
actions, accent-insensitive search, combobox/listbox a11y), mobile drawer,
and a global session-expired handler (any 401 → sign out →
`/login?expired=1` with a banner).

## 5. Overview

Answers "what is happening today?" only with real API data: appointments
scheduled today (org timezone), open orders (DRAFT + CONFIRMED), products at
zero stock (server-side `zeroStock` filter), active customers; today's
appointments, recent orders, zero-stock products. Lists are capped at 100 by
the APIs and there is no count endpoint, so a full page shows "100+", never
a guessed total. Each block degrades on its own (module not in plan →
"Módulo indisponível"; permission; error). No activity feed — no audit-read
API exists (gap G5).

## 6. Modules (Phase 5)

Every list uses `ListPage` (header, filters, `DataTable`, empty/loading/error,
`ResultLimitNotice` at 100, `?new=1` create dialogs from the command menu);
every detail uses `DetailGuard` + `ResourceHeader` + `Section`; every
destructive or state-changing action goes through `ConfirmDialog` that shows
the server's reason and stays open on failure. Specific improvements:
products (stock balance, reactivate), categories (edit/archive/reactivate),
customers (their recent orders; names resolved by id — fixes the old "—"
for archived/beyond-first-page customers), services (associated
professionals), professionals (section anchors `#horario`, `#excepcoes`,
`#disponibilidade`), inventory (decimal-string movements), orders (lifecycle
dialogs explaining stock effects), appointments (breadcrumbs, pt money),
scheduling hub. Money renders as `1 850,50 Kz` from the API's decimal string
(no float math); quantities `250,5 kg`.

## 7. Integration Center (Phase 8)

| Page | What it shows | Source |
|---|---|---|
| API | base URLs, organization id (copy), auth model, curl example with a `$NA_PISTA_KEY` placeholder, module → scope table, real `api_requests` meter (OWNER/ADMIN/MANAGER) | config + Platform usage API |
| Credenciais | list (id prefix, status, scopes, created, expiry), create (OWNER) with real scopes and optional expiry, **one-time secret** ("Este segredo só será mostrado uma vez"), copy, revoke via confirmation with a platform-credential warning, scopes explained by what they unlock | Platform API keys + service-scopes |
| Ambientes | the NA_PISTA environments/endpoints the Platform declares, read-only | Platform |
| Webhooks | banner: Na Pista does not publish events yet; list; create (secret once); test (real delivery result); revoke | Platform webhooks |
| Documentação | fundamentals, common errors, searchable catalog of all 56 endpoints with permission + scope + curl | derived from Na Pista routes/schemas; a test checks it stays consistent with the permission model |

Secret handling: the secret lives only in the dialog's state — it is stripped
before the credential enters the list state, never logged, never stored in
the browser, and is gone when the dialog closes (tested, and verified live).
No hash, no service-role key is ever shown or shipped to the browser.

Verified live (manual validation): a `catalog.read` credential created in
the Console → `GET /products` 200, `POST /categories` 403 `Missing scope:
catalog.write`; revoked in the Console → 401 immediately.

## 8. Errors, UX quality, permissions & entitlements (Phases 9–11)

- `lib/errors.ts`: contextual pt-PT title per code (generic, commerce,
  scheduling, appointment codes), the server's *safe* message as detail
  (uninformative ones dropped), request reference, login link on 401,
  network failure explained. Never SQL, constraint names, stacks, driver
  errors or secrets (the backends already never send them; the UI never
  adds any).
- Login: sanitized provider errors (never echoes provider internals),
  expired-session banner, redirect when already signed in.
- Loading skeletons, disabled/busy buttons (no double submit), toasts, focus
  management in dialogs, labelled controls, `aria-current`, table headers
  with `scope`, keyboard menus/tabs.
- Permissions: controls a role cannot use are **absent**, pages it cannot
  read show `PermissionDenied`; Settings › Permissões shows both matrices
  read-only. Entitlement denial shows `ModuleUnavailable`, not an error.
- Team (Platform memberships): change role/suspend/reactivate/remove with
  confirmation; the Platform's "last active owner" rule is shown in the
  dialog. No add-member form (gap G3).

## 9. Manual validation (Phase 12)

`docs/manual-validation.md`. Provisionable, never committed, no fixed ids:

- `ul-platform`: `npm run mv:provision` / `mv:teardown`
  (`scripts/manual-validation-{provision,teardown}.ts`) — real Supabase Auth
  users (OWNER/ADMIN/MANAGER/STAFF × 2 orgs), memberships, `NA_PISTA/BUSINESS`
  subscriptions, platform-facing + integration credentials, all through the
  Platform's own API with each user's real token.
- `na-pista`: `npm run mv:server` (dev launcher, see G1), `mv:seed` (realistic
  data through the public HTTP API only), `mv:teardown`.
- Output `na-pista/.fixtures/manual-validation.json` (git-ignored, contains
  passwords/secrets; nothing secret printed).

Run in this phase: provisioned, seeded (PRODUCT_REFERENCE: 3 categories, 8
products, 4 customers, 4 orders in every state; SERVICE_REFERENCE: 5
services, 3 professionals, 3 customers, 8 appointments), signed in with real
users and reviewed the pages (§11).

## 10. Tests (Phase 13)

Console (Vitest + RTL): **15 files, 166 tests, all passing** (88 existing + 78 new),
re-run after the visual-QA fixes — see §14. New:

| File | Covers |
|---|---|
| `lib/f29-logic.test.ts` (20) | error mapping, money/count/date formatting, navigation per role, Platform permission mirror, status vocabulary, API-catalog ↔ permission/scope consistency, scope grouping |
| `components/ui/ui.test.tsx` (16) | Button busy, Field a11y, ErrorNotice, ModuleUnavailable, ResultLimitNotice, DataTable, Modal, ConfirmDialog (success/failure), Dropdown, Tabs, Toast, CopyButton |
| `components/shell/shell.test.tsx` (10) | sidebar/active item, STAFF nav, org switcher, user menu, drawer, session expiry redirect, command menu, env indicator |
| `integrations/integrations.test.tsx` (15) | credentials (secret once and gone after close, revoke confirm, ADMIN read-only, MANAGER denied, scopes, errors), webhooks, environments, API overview, docs |
| `overview.test.tsx` (8) | real counts and "100+", entitlement degradation, no timezone, STAFF; Team (confirm, last-owner error, read-only); Permissions |
| `orders/[orderId]/page.test.tsx` (4) | confirm dialog, insufficient stock in dialog, STAFF read-only, not found |
| `login/page.test.tsx` (3), `lib/useAsync.test.tsx` (2) | expired banner, sanitized errors; stale responses, disabled |

Existing tests changed (intentional, behaviour changes of F29 — not
weakened):

- `professionals/page.test.tsx`: list call now includes `limit: 100`; status
  "ACTIVE" → "Activo" (pt-PT vocabulary).
- `customers/[customerId]/page.test.tsx`: mocks `lib/api/orders` (page now
  lists the customer's orders).
- `professionals/[professionalId]/page.test.tsx`: archive confirms in the
  dialog; `15.00 AOA` → `15,00 Kz`.
- `appointments/[appointmentId]/page.test.tsx`: `10000.00 AOA` → `10 000,00 Kz`.
- `settings/page.test.tsx`: mocks `lib/api/platform` (page now also shows the
  Platform organization profile).

## 11. Visual QA

Reviewed in Chrome with real users and seeded data: login, organization
picker, Overview (both orgs), products, orders (names resolved), inventory,
credentials (full create → use → revoke cycle), webhooks, environments,
docs, team, settings, scheduling hub, appointments day view and detail
(STAFF: no actions), cross-tenant URL ("Sem acesso a esta organização").

Found and fixed during QA: sidebar horizontal scrollbar; "requer fuso
horário" flashing on the Overview while the timezone was still loading;
status badges stretched to full width inside detail fields; decimal
quantities rendered with a dot (`250.5 kg` → `250,5 kg`).

Not verified in the browser: the mobile drawer at phone width (the browser
window could not be narrowed to a phone viewport in this environment); it is
covered by the shell test and CSS only.

## 12. Backend changes

**None.** `na-pista/src` and `ul-platform/src` are unchanged. Gaps found are
documented below with a proposed change, per the brief ("PARAR. Documentar").

## 13. Open gaps

| # | Gap | Contract missing | Why it matters | Proposed backend change |
|---|---|---|---|---|
| **G1** | **A running Na Pista server cannot serve any tenant.** Platform-facing credentials live in an in-memory registry (`src/platform/serviceAuth.ts`) populated only by tests → every tenant request of `npm run dev`/`start` is `503 UPSTREAM_UNAVAILABLE`. | Na Pista credential storage + provisioning | Blocks any real use of the Console or a custom UI outside tests | Persist one encrypted platform credential per organization in Na Pista's DB (KMS/secret-store key), provisioned on subscription activation (Platform webhook or admin flow), with rotation. F29 works around it for local validation only (`mv:server`). |
| G2 | No pagination/total counts | cursor/offset + total on list endpoints | Lists stop at 100 (appointments 500); Overview shows "100+" | Keyset pagination (`cursor`) + optional `total` |
| G3 | No member invite | Platform invite-by-email / user lookup | Team page cannot add members | `POST /organizations/:id/invitations` (email, role) |
| G4 | Webhook URL and deliveries not readable; no `lastUsedAt`; keys not environment-scoped | Platform read models | Integrators cannot see where events go or delivery history; cannot spot stale keys | Return a masked URL; `GET …/webhooks/:id/deliveries`; `lastUsedAt`; optional environment binding |
| G5 | No audit read API | `GET …/audit-events` (Na Pista) | No activity feed / history view | Read endpoint filtered by resource, gated by a new permission |
| G6 | Na Pista publishes no events | event publication (ADR-050 planned) | Webhooks only receive `webhook.test` | Implement ADR-050 |
| G7 | No OpenAPI document | machine-readable contract | Docs page is derived by hand (guarded by a consistency test) | Generate OpenAPI from the Zod schemas |
| G8 | No stock thresholds | per-product minimum stock | Only "zero stock" can be surfaced | `minQuantity` on inventory + filter |
| G9 | Platform CORS for the Console | deployment config | `PLATFORM_ALLOWED_ORIGINS` must include the Console origin (dev default does not include `:3010`) | Config only — documented in manual-validation §2 |

Observation (authorization, not changed): `DELETE /products|categories|customers/:id`
(archive) requires `*.delete`, but ADR-020 lets `PATCH {status: "ARCHIVED"}`
change status with `*.update`, so a MANAGER can archive through PATCH. The
Console mirrors the `DELETE` tier (hides "Arquivar" for MANAGER). Decide
whether PATCH should require `*.delete` when `status` changes to `ARCHIVED`.

## 14. Verification

| Check | Result |
|---|---|
| console `npm run typecheck` | pass |
| console `npm run lint` | pass (0 problems) |
| console `npm test` | 15 files, 166 tests, all pass (re-run after the visual-QA fixes) |
| console `npm run build` | pass (29 routes) |
| na-pista `npm run typecheck` (includes `scripts/`) | pass |
| na-pista `eslint scripts` | pass |
| manual validation | provisioned, seeded, reviewed live (§9, §11) |

No Na Pista or UL Platform source changed, so their suites were not re-run for
F29 (the F28B regression, run in the same session, is in `docs/f28b-report.md` §12).

Commits: `na-pista-console` `9a365dd`; `ul-platform` `5f5034c` (dev scripts);
`na-pista` — the commit containing this report (docs + dev scripts).
