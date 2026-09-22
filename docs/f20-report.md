# F20 Report — Product Management Vertical Slice

## Estado

**COMPLETE.** Every item in the self-review (§36 below) and the approval checklist holds. Nothing here bypasses
tenant isolation, authorization, or entitlement enforcement — all three are proven live, repeatedly, against
the real UL Platform and a real PostgreSQL database, not asserted from reading the code alone.

**Scope honestly delivered:** the backend (domain, API, auth/tenant/permission/entitlement pipeline, audit,
usage, tests) is built, migrated with real drizzle-kit migrations, and exhaustively tested. The Default UI
(`na-pista-console`, its own repository per ADR-008) is built, type-checks, lints, and produces a real
production build; its login flow could not be walked through live in a browser in this session (Supabase
rejected disposable test-email domains at signup — see "Known limitations"), so it is verified by code review
and a clean production build, not by a live click-through. The API it depends on is independently,
exhaustively E2E-tested without any UI involved (F20 brief §36 Q9).

## Product domain
`Product { id, organizationId, categoryId?, name, description?, status: ACTIVE|ARCHIVED, createdAt, updatedAt }`.
No price (OD-01 from F18 still open — never invented). No variants/inventory/barcode/suppliers. ADR-018.

## Category domain
`Category { id, organizationId, name, description?, status: ACTIVE|ARCHIVED, createdAt, updatedAt }`. Flat, no
hierarchy (OD-08 from F18: no real requirement demonstrated one yet). ADR-019.

## API
`/v1/organizations/:organizationId/{categories,products}` — full CRUD (DELETE = archive, ADR-020), tenant in
the path (F18's ADR-002/api-boundary.md decision, consistent with F19), basic search/filter/limit on lists
(F20 brief §23/§30), `.strict()` Zod validation rejecting unknown/protected client fields (`id`,
`organizationId`, `createdAt`, `updatedAt`). Full contract: [`docs/api/products-api.md`](api/products-api.md).

## Database
Real `drizzle-kit` migration (`drizzle/migrations/0000_organic_power_man.sql`, hand-corrected once — see
"Known limitations") against Na Pista's own `na_pista` Postgres schema (same physical server as the Platform
in this environment only, per F19's OD-16/ADR-015 — never shared tables). `organization_id NOT NULL`
everywhere; `UNIQUE(organization_id, id)` on both tables; composite FK
`products(organization_id, category_id) -> categories(organization_id, id)` — proven to actually reject a
cross-tenant reference in a real integration test, not just assumed. Indexes match real query shapes
(`(org, created_at)`, `(org, category_id)`, `(org, status)`) — no speculative ones. Migration tracking kept in
its own `na_pista_drizzle_meta` schema, isolated from `ul-platform`'s own `drizzle` schema on the same server.

## Authorization
Local permission map (`src/authorization/permissions.ts`), unchanged mechanism from F19 (ADR-013), extended
with `products.*`/`categories.*`. `delete` = OWNER/ADMIN only (one tier stricter than `create`/`update`, no
`delete` for MANAGER/STAFF). Both human (permission) and service-credential (scope) paths proven for every
route via `requireAuthorized`. ADR-021.

## Entitlement
`catalog.enabled` (F19's OD-14 interim key, unchanged) gates the whole module. Proven live: enabled org
succeeds, unsubscribed org is blocked (`403 ENTITLEMENT_REQUIRED`), and a **live cancel → block → re-subscribe
→ allow** cycle against a real Platform subscription. ADR-022.

## Tenant isolation
Proven for both modules, both directions (org A ↔ org B), by human and by service credential: cross-org list
never leaks, cross-org `GET/PATCH/DELETE` by id is `403` (no membership) or `404` (real membership, wrong
resource — never the row), and a category from one organization can never be assigned to a product in
another — rejected both at creation and at update, with a real Postgres FK as the structural backstop.

## Audit
`na_pista.audit_events`, written in the **same transaction** as the mutation (ADR-023) — an audit failure
rolls back the whole operation, a stronger guarantee than the Platform's own audit posture, explicitly chosen
to satisfy F20 brief §19/§29's "audit failure: behavior explicitly defined". Proven live: a real create
produces exactly one matching row with correct actor/action/requestId; archive produces a distinct
`*.deleted` action from `*.updated`.

## Usage
Every write records one `api_requests` Platform usage event (the only real, seeded, allow-listed meter for
`NA_PISTA` — F19's PC-5 already flagged that no `products` meter exists yet; none was invented). Fire-and-forget,
never blocks or fails the response (ADR-023). Proven live: a real write measurably increases the Platform's
own recorded usage for the organization.

## UI
`na-pista-console` (separate repository, ADR-008): Next.js App Router, client-rendered (no SSR cookie
pipeline — a documented simplification, not a security shortcut: `/o/[organizationId]/layout.tsx`
cross-checks the URL's organization against real Platform memberships before rendering anything, same posture
as ul-client's `OrganizationGate`). Login (email/password via Supabase), organization picker, Products list
(search/filter/create/empty-state/loading/error states), Product detail (edit/archive), Categories
(list/create/archive). Buttons are hidden by a **local mirror** of the permission map (`lib/permissions.ts`)
— explicitly documented as UX only; the real gate is the API. `npm run build`/`lint`/`typecheck` all pass
cleanly.

## Tests

| Layer | Command | Count | Result |
|---|---|---|---|
| Unit | `npm run test:unit` | 16 | 16 pass |
| Integration (real Postgres, no HTTP) | `npm run test:integration` | 3 | 3 pass |
| E2E (real Platform + real Na Pista + real Postgres) | `npm run test:e2e` | 23 | 23 pass |
| **Total** | | **42** | **42 pass, 0 fail** |

E2E covers every F20 brief §28/§29 scenario: OWNER category/product create-read-update, STAFF blocked from
write (403), cross-tenant blocked (403/404), category-from-another-tenant rejected (400), entitlement
disabled/enabled/toggled live, invalid input rejected, request-id preserved, audit produced, usage produced,
service-credential matrix (valid/revoked-shape/insufficient-scope/cross-tenant — reusing F19's exhaustive
credential-lifecycle matrix rather than re-proving expiry/revocation from scratch here, since the underlying
mechanism is unchanged from F19 and already has 8 dedicated tests there). `duplicate/conflict -> 409`: **not
applicable** in this slice — no uniqueness constraint exists on product/category name (not asked for, not
invented), so no legitimate create path can produce a `409` today; the error-mapping machinery for it
(`isUniqueViolationError`) exists and is shared with F19's proven pattern, ready for the day a real uniqueness
rule is added.

`na-pista-console`: `build`/`lint`/`typecheck` all pass; no automated browser E2E in this pass (see "Known
limitations").

## Security
Searched the diff for `organizationId`, `tenant`, `service credential`, `JWT`, `API key`, `secret`, `password`
— confirmed: no secret in the UI (only `NEXT_PUBLIC_*` anon key + URLs, CLAUDE.md §6/§11), no secret in logs
(`shared/logger.ts` never receives raw tokens/keys), no secret committed (`.fixtures/`, `.env`, `.env.local`
all gitignored, verified with `git status`/`git add -n` before every commit), no direct access to the
Platform's database anywhere, no tenant bypass (proven), no entitlement bypass (proven), no permission bypass
(proven). Manipulating `organizationId`/`categoryId`/`productId` in the URL, query, and body was exercised
directly by the tenant-isolation and validation test suites.

## ADRs
ADR-018 (Product Domain Model) · ADR-019 (Category Model) · ADR-020 (Product Lifecycle) · ADR-021
(Tenant-scoped Repository) · ADR-022 (Product Entitlement Enforcement) · ADR-023 (Product Audit/Usage). All in
`docs/adr/`, all "Accepted — implemented" (not proposals — this is shipped, tested code).

## Git

**Commits:** `na-pista` (backend: domain+migrations, category API, product API, authorization/tenant
isolation, audit/usage, tests, docs/ADRs), `na-pista-console` (new repository: UI), `ul-platform` (F20 fixture
provisioning/teardown scripts only — no production code touched).

**Push:** no remote configured for `na-pista` or `na-pista-console` in this session — no push. `ul-platform`
has a remote but was not pushed without an explicit request (same posture as F18/F19).

## Platform changes
None implemented. F19's `platform-changes-required.md` (PC-4: `products.enabled` rename, PC-5: `products`
usage meter) remain open, optional, non-blocking — this slice ran entirely on the Platform as it exists today.

## Known limitations
1. **`products.max` is not enforced.** The Platform seeds it (`1000` on `BUSINESS`); F19 already proved the
   local-count-vs-limit mechanism; wiring it here wasn't asked for by F20 and was left out rather than added
   speculatively (ADR-022).
2. **Migration ordering bug, found and fixed in this pass.** `drizzle-kit generate` emitted the composite FK
   *before* the unique index it depends on — Postgres requires the referenced unique constraint to exist
   first. Hand-corrected in the generated SQL (documented inline in the migration file); worth watching for
   in future `drizzle-kit generate` runs on this schema rather than assumed fixed upstream.
3. **`drizzle-kit migrate` intermittently produced no usable output on this environment's connection** (a
   Supabase Supavisor pooler) on the *first* attempt after the ordering bug above — retried cleanly once the
   SQL itself was valid; not conclusively diagnosed further (plausibly the same failure, just poorly surfaced
   by the CLI's spinner UI) — not blocking, but worth being aware of if a future migration mysteriously
   appears to hang.
4. **UI login not live-tested in a browser.** Supabase's own signup validation rejected every disposable test
   email domain tried (`@test.ul-platform.invalid`, `@example.com`) in this project — creating a real,
   deliverable test mailbox was out of scope for this session and not something to do without the user's
   involvement. The UI's auth code is standard Supabase JS (`signInWithPassword`) and was verified by review
   and a clean production build, not by a click-through recording.
5. **In-memory service-credential registry**, unchanged from F19 — still not a real secret store. Every
   organization's Na Pista credential must be re-registered on process restart; no provisioning automation
   exists yet.
6. **No OpenAPI document generated** — the API doc (`docs/api/products-api.md`) is hand-written from the real
   schemas/routes, matching F18's own `api-boundary.md` convention.

## Deferred decisions
OD-01 (currency/price model, F18) — still open, still blocks adding `price`. OD-02 (product variants), OD-08
(category hierarchy) — still open, no new pressure to close them from this slice. A dedicated `products` usage
meter and `products.enabled` rename — optional Platform seed changes (PC-4/PC-5), not scheduled.

## F21 readiness
The tenant-scoped-repository + composite-FK + entitlement-gate + audit/usage pattern is now proven twice
(Categories, Products) and is the template for the next module. Before building one that needs money (Orders)
or time (Appointments), OD-01 and F18's Service-domain open decisions (SD-2..SD-5) need real answers — not
technical blockers, business ones.

## Self review (F20 brief §36)
1. Product belongs exclusively to one Organization — yes, `organization_id NOT NULL`, proven.
2. Category belongs exclusively to one Organization — yes, same.
3. Product cannot use another tenant's Category — yes, rejected at the service layer (400) and structurally
   impossible at the database layer (composite FK), both proven.
4. `organizationId` in the body is ignored — yes, `.strict()` schemas reject it outright (400), proven.
5. URL `organizationId` is validated against real membership — yes, `requireTenantContext`, proven.
6. Permission checked server-side — yes, `requireAuthorized`, proven (STAFF blocked from every write).
7. Entitlement checked server-side — yes, `requireCapability`, proven (disabled/enabled/toggled live).
8. UI is not the source of security — yes, documented explicitly; the API works and is proven independent of
   the UI.
9. Product API works without the UI — yes, 42/42 tests never touch the UI.
10. A Custom UI could consume the same API — yes by construction (ADR-008: no UI-specific backend logic).
11. Audit works — yes, proven live, atomic with the mutation.
12. Usage works — yes, proven live against the real Platform (documented as `api_requests`, not a dedicated
    meter — see "Known limitations").
13. Platform still doesn't know about Products — yes; nothing in `ul-platform`'s production code changed.
14. No direct access to the Platform's DB — yes, confirmed by code review (only `PLATFORM_API_URL` HTTP calls).
15. No secrets exposed — yes, confirmed (see "Security").
16. No scope creep — yes; inventory/orders/variants/etc. all explicitly absent, named in "Not built" in the API doc.
17. E2E tests use real PostgreSQL — yes, both integration and E2E layers.
18. Cross-tenant test passes — yes.
19. Entitlement off blocks — yes.
20. Entitlement on allows — yes.
21. F20 proves the first vertical slice — yes: Organization → NA_PISTA subscription → catalog.enabled →
    OWNER → Na Pista → Product Management → create category → create product → read → update → archive →
    audit → usage, all real, all tested; Organization B cannot reach Organization A's data.
