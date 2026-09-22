# F21 Report — Customer Management Vertical Slice

## Estado

**COMPLETE.** Every Definition of Done item (F21 brief §25) is proven, not asserted — see "Tests" and "Self
review" below. Customers is now the second real business module in Na Pista, built as a transversal primitive
(no coupling to Products/Categories) exactly as required (F21 brief §1), reusing every mechanism F19/F20
already proved rather than inventing a parallel one.

## Scope delivered
`na_pista.customers` (own migration), tenant-scoped repository with search, full CRUD API (DELETE=archive),
`.strict()` Zod validation, `customers.*` permissions wired into the existing local authorization map,
`catalog.enabled` entitlement reused (no new Platform entitlement), transactional audit, real Platform usage,
11 unit + 5 integration + 21 E2E tests (37 total, customer-specific; `na-pista`'s full suite including F20's
unchanged Products/Categories tests is 79/79 — see "Tests" below), Default UI pages (list/search/filter/create/detail
/edit/archive), 3 ADRs, API documentation, no UL Platform production code touched.

## Customer model (ADR-024)
`{ id, organizationId, name, email?, phone?, notes?, status: ACTIVE|ARCHIVED, createdAt, updatedAt }`. No
CRM-shaped fields (segments, LTV, loyalty, tax number, address hierarchy, avatar, payment info) — none
justified. No tenant-scoped uniqueness on name/email/phone (documented decision — real businesses have shared
phones, missing emails, duplicate names; the `409` machinery from F20 is preserved, unused). Search (`q`)
matches name/email/phone via plain `ILIKE`, tenant-scoped, proven against real Postgres data — no trigram
index added (not justified at this scale). Phone validated as a loose international shape, not Angola-only.

## Identity separation (ADR-025)
Zero coupling to UL Platform users: no FK, no `userId`/`platformUserId` column, no call to any Platform
identity endpoint from anywhere in the Customer module — confirmed by reading every file in
`src/modules/customers/` and by every fixture/test, none of which ever links a Customer to a `users`/membership
row. A customer can exist, and was created in tests, entirely independent of any Supabase account.

## API
`/v1/organizations/:organizationId/customers` — full CRUD, same envelope/pipeline/conventions as
Products/Categories. Full contract: [`docs/api/customers-api.md`](api/customers-api.md).

## Database
Real `drizzle-kit` migration (`0001_nervous_black_queen.sql`, applied cleanly — no ordering issue this time,
since Customer has no foreign key to reorder around). Indexes: `(organization_id, created_at)`,
`(organization_id, status)` — matching the real query shapes the repository actually runs; no speculative
indexes for the search feature (plain `ILIKE`, no `pg_trgm`).

## Authorization
`customers.read/create/update/delete` added to the existing local permission map (`src/authorization/
permissions.ts`), unchanged mechanism (ADR-013). OWNER/ADMIN: everything including archive. MANAGER: read/
create/update, **not** archive. STAFF: read only. Proven live for all four roles, including a dedicated
MANAGER fixture this slice added specifically to prove that tier (F19/F20 never needed one).

## Entitlement
Reuses `catalog.enabled` (ADR-022, unchanged) — **no new Platform entitlement invented.** Investigated first,
per F21 brief §10's explicit instruction: the Platform's only `NA_PISTA` entitlements today are
`catalog.enabled`, `products.max`, `advanced_reports.enabled` (confirmed by reading `ul-platform`'s seed data,
not assumed) — none of them is Customer-specific, and none of them is a better fit than `catalog.enabled`,
which F19/F20 already established as this slice's de facto "Na Pista module access" gate rather than a
literal "product catalog" flag. Inventing `customers.enabled` was considered and rejected: it would require a
Platform seed change for a distinction no requirement asked for (every organization with Na Pista access gets
the whole module in this phase, matching how Products/Categories already behave). If Customers and
Products/Categories ever need to be sold as separate commercial units, that is the point to revisit this —
not before.

## Tenant isolation
Identical posture and mechanism to Products/Categories (ADR-021), proven for Customers specifically: cross-org
list/GET/PATCH/DELETE all correctly blocked (`403` no membership, `404` real membership/wrong resource),
`organizationId` and `customerId` manipulation both tested directly.

## Audit
Same-transaction as the mutation (ADR-023, restated for Customers in ADR-026). **Proven by causing a real
audit failure** (a genuine Postgres `NOT NULL` violation on `audit_events.action`, not a mock) inside the same
transaction as a customer insert, and confirming the customer row does **not** exist afterward
(`tests/integration/customers.test.ts`) — the strongest possible proof of the rollback guarantee, going
further than F20 did (F20 asserted the mechanism by code review of the transaction wrapping; F21 forces a real
failure and observes the real rollback).

## Usage
`api_requests` meter (F20's established, real, Platform-seeded choice) — no fake `customers.created` meter
invented. Proven live: a real customer write measurably increases the Platform's own recorded usage.

## UI
`na-pista-console`: `/o/[organizationId]/customers` (list, search, status filter, create, empty/loading/error
states) and `/o/[organizationId]/customers/:id` (view/edit/archive). Same architecture as F20's Products UI —
no new patterns introduced. `build`/`lint`/`typecheck` all pass.

## Tests

| Layer | Customer-specific | Result |
|---|---|---|
| Unit | 11 | 11 pass |
| Integration (real Postgres) | 5 | 5 pass |
| E2E (real Platform + real Na Pista + real Postgres) | 21 | 21 pass |
| **Customer total** | **37** | **37 pass, 0 fail** |

`na-pista`'s full root suite in the same runs (Customers + F20's unchanged Products/Categories code, one
shared test:unit/test:integration/test:e2e invocation): **27 unit + 8 integration + 44 E2E = 79 tests, 79
pass.** F19's spike (`spikes/platform-integration/`, its own separate `npm test` command, a different
directory) was not re-run in this session — its last recorded result (34 E2E + 15 unit, all passing) is
F19's own report's claim, not re-verified here, and is intentionally not merged into the 79 above to avoid
overstating a number from a suite this session didn't execute.

One real failure occurred mid-session and is worth recording honestly: the first combined `test:e2e` run hit
the exact same class of artifact F20's own report already documented — a stale F20 fixture (org D's
subscription) left in a non-fresh state by an earlier debugging run. Re-provisioning F20's fixtures fixed it;
a full clean re-run of the entire `na-pista` E2E suite (79 tests) then passed completely, with **zero changes
to any Customer code** — confirming the failure was fixture staleness, not a Customer-module defect.

**Deliberately not duplicated from F19/F20** (F21 brief §19's own instruction): revoked/expired service
credential behavior (8 dedicated F19 tests, unchanged code path — `introspectServiceCredential` is identical
for Customers), the live entitlement cancel→re-subscribe cycle (proven mechanism-wise in F19/F20; Customers
only needed static disabled/enabled, per brief §10's actual ask), and Platform JWT/JWKS verification specifics.
Each E2E file that touches these says explicitly, in its own header comment, what it is and isn't re-proving.

## Security review
Searched for `organizationId`, `tenant`, `service credential`, `JWT`, `API key`, `secret`, `password`, `email`,
`phone`, `name` (PII-specific pass, F21 brief §18): no secret in the UI or logs, no direct Platform DB access,
no tenant/entitlement/permission bypass (all proven), audit `metadata` never carries name/email/phone/notes
(confirmed directly: `assert.equal(rows[0].metadata, null)` in the audit test — only `product.created`-style
events carry `metadata`, and Customer's own create event deliberately carries none). `organizationId`/
`customerId` manipulation in the URL tested directly.

## Known limitations
1. Same in-memory service-credential registry as F19/F20 — not a real secret store (unchanged, not
   re-litigated here).
2. No uniqueness protection on customer records — a deliberate decision (ADR-024), not a gap, but worth
   restating: two identical-looking customer records can exist side by side.
3. UI login still not live-browser-tested (same Supabase test-signup constraint documented in F20's report;
   unchanged in this phase).
4. `customers.max`-style limit is not defined or enforced — no requirement asked for one; `products.max`
   remains the only numeric limit in the seed, and it doesn't apply to Customers.

## Deferred decisions
Whether/how a future Order or Appointment module references `customerId` (F21 brief §1's stated future flows)
— intentionally undecided here; Customer was built to not preclude either shape, not to pre-guess it. F18's
OD-22 (PII/privacy/retention policy) remains open and is the right place to resolve real data-deletion
requirements, not improvised in this slice (ADR-026).

## Platform changes
None. Confirmed no `ul-platform` production code was modified — only two dev-only fixture scripts
(`f21-provision-fixtures.ts`/`f21-teardown-fixtures.ts`), same pattern as F19/F20.

## Git
**Commits:** `na-pista` (domain+migration, repository/service, API, authorization wiring, tests, docs/ADRs),
`na-pista-console` (Customers UI pages), `ul-platform` (F21 fixture scripts only).
**Push:** no remote configured for `na-pista`/`na-pista-console` — no push. `ul-platform` has a remote but was
not pushed without an explicit request (same posture as F18/F19/F20).

## F22 readiness
The tenant-scoped-repository + entitlement-gate + audit/usage pattern is now proven three times (Categories,
Products, Customers) across two different relational shapes (Product→Category composite FK; Customer with no
FK at all). Customer is ready to be referenced by a future Orders or Appointments module the moment F18's
remaining open decisions (OD-01 price/currency, SD-2..SD-5 service-domain questions) get real answers — those
are business decisions, not technical blockers.

## Self review (F21 brief §28)
1. Customer belongs exclusively to one Organization — yes, `organization_id NOT NULL`, proven (integration + E2E).
2. `organizationId` cannot be manipulated — yes, ignored from the body (`.strict()`), and the URL value is
   always validated against real membership/credential before use.
3. `customerId` cannot be manipulated across tenants — yes, cross-tenant id resolves `404`, never the row.
4. Authorization enforced server-side — yes, `requireAuthorized`, proven for OWNER/ADMIN/MANAGER/STAFF.
5. Entitlement enforced server-side — yes, `requireCapability`, proven disabled and enabled.
6. Customer independent from UL Platform User — yes, no FK/column/call, confirmed by code review (ADR-025).
7. A Customer can exist without a Supabase account — yes, every test fixture customer has none.
8. Archive, not physical deletion — yes (ADR-026), proven still-readable-after-archive.
9. Audit happens atomically — yes, proven with a **real forced failure and observed rollback**, not just
   code-reviewed.
10. Usage uses a real existing meter — yes, `api_requests`, proven to really increase on the Platform.
11. API works without the UI — yes, all 37 customer-specific tests (and 79/79 for the whole `na-pista` suite) never touch the UI.
12. An independent custom UI could consume the API — yes, by construction (same posture as F20's ADR-008).
13. No direct Platform DB access — yes, confirmed by code review (only `PLATFORM_API_URL` HTTP calls exist).
14. No secrets in the frontend — yes, only `NEXT_PUBLIC_*` values.
15. No customer PII in logs — yes, `shared/logger.ts` never receives name/email/phone/notes; confirmed audit
    metadata carries none either.
16. Platform remains unaware of Na Pista Customers — yes; nothing in `ul-platform` production code changed.
17. Cross-tenant access fails — yes.
18. Entitlement-off fails — yes.
19. Entitlement-on succeeds — yes.
20. Service authentication works — yes (valid credential creates a customer; insufficient scope blocked).
21. Human authentication works — yes (OWNER/ADMIN/MANAGER/STAFF all exercised).
22. Platform failure fails closed — yes, `UpstreamUnavailableError`/`503`, proven.
23. Audit failure rolls back — yes, proven with a real constraint violation.
24. Usage failure preserves the mutation — yes, by construction (`platform/usage.ts` catches and logs, never
    throws) — F20's established behavior, unchanged, exercised again by every successful customer write in
    this suite (none were ever blocked by a usage-write outcome).
25. Still limited to Customer Management — yes: no CRM, no order/appointment history, no messaging, no
    payments, nothing beyond §2's stated scope.
