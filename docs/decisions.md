# F19 — Decision register (OD-11, OD-12, OD-13, OD-14, OD-16)

> Every decision below was tested in runtime against the REAL, already-running UL Platform (real HTTP API,
> real PostgreSQL — the same Supabase project `ul-platform/.env` points at) from
> `na-pista/spikes/platform-integration`, not against a mock. Fixtures are real Platform data, provisioned by
> `ul-platform/scripts/f19-provision-fixtures.ts` and removable by `scripts/f19-teardown-fixtures.ts`. See
> `docs/f19-report.md` for the full test run and pass/fail counts.

## OD-11 — Na Pista service identity

**Status: CLOSED.**

**Decision: Alternative A — one organization-scoped `NA_PISTA` API key per Organization**, held by Na Pista
itself (`src/platform/serviceAuth.ts`), never a platform-wide credential.

**Rationale.** Alternative B (a single Platform-wide application credential that can act on any organization)
does not exist in the Platform today and cannot exist without a Platform code change: every service-scoped
middleware (`requireEntitlementAccess`, `requireServiceOrganizationMatch`, `requireServiceApplicationMatch`)
compares the credential's own **stored** `organizationId` against the URL, and a platform-level credential's
`organizationId` is `null` — it can never equal a real UUID, so it is structurally rejected everywhere an
organization-scoped operation is needed (confirmed by reading `middleware/requireServiceOrganizationMatch.ts`
and `middleware/entitlementAccess.ts`, and empirically: `platformFacingA`/`platformFacingD`/`platformFacingE`,
all organization-scoped keys, successfully read entitlements and would successfully write usage/publish events;
no platform-level key was even attempted against an organization-scoped endpoint because the code makes the
outcome certain without needing to prove a 403 via a route that structurally cannot exist for it — see
`ul-platform/README.md` "API Keys" §"Ownership/scope model" for the same conclusion from the Platform's own
side). Alternative A is therefore not "the simpler one chosen for convenience" — it is **the only one
implementable today**; Alternative B is recorded as a Platform-side option below, not built.

**Rejected alternative (B).** A single `NA_PISTA` platform-level credential (`organizationId = null`,
`POST /v1/platform/credentials`) acting on behalf of any organization. Would need the Platform to add a new
authorization path — see `platform-changes-required.md` §PC-1. **Not implemented.**

**Security implications.**
- **Isolation**: a credential is physically incapable of crossing organizations — proven live in
  `tests/e2e/tenant-isolation.test.ts` ("a service credential scoped to org A cannot read org D's products")
  and `tests/e2e/service-auth.test.ts` ("credential from org A used against org B's path -> 403").
- **Blast radius of one compromised key**: exactly one organization, never the whole platform. Alternative B's
  blast radius would be every organization Na Pista serves.
- **Two credential classes per organization, never merged** (see `authorization.md` §3.1, executed in
  `serviceAuth.ts`/fixtures as `platformFacing*` vs `integration*`): an organization's own integration client
  never holds `usage.write`/`event.publish`; Na Pista's own outbound credential never appears in a tenant's
  own integration surface. This mitigates PG-8 (an OWNER can mint any allowlisted scope) — it does not remove
  the underlying Platform gap, which remains real and is recorded in `platform-changes-required.md` §PC-2.

**Operational implications.** N organizations = N secrets Na Pista must hold, one per org, created at
subscription time and rotated/revoked independently. This spike's `serviceAuth.ts` registry is an in-memory
`Map` — **explicitly not** how a real deployment should store these; a real implementation needs a secret
store (e.g. an encrypted column keyed by `organizationId`, or a KMS-backed vault), provisioning automation
tied to `subscription.created`, and a rotation runbook (create → deploy → verify → revoke old, same pattern
`ul-platform`'s own README documents for its own keys). Console/Custom UI impact: **none** — this is entirely
an Na Pista-internal credential; no UI needs to know about it.

**Platform changes: NONE required to close this decision.** (Alternative B, if ever wanted, is optional
future Platform work — see `platform-changes-required.md` §PC-1.)

**Evidence.** `tests/e2e/service-auth.test.ts`, `tests/e2e/tenant-isolation.test.ts`,
`tests/e2e/entitlements.test.ts` (every entitlement read in this spike went through an org-scoped credential).

---

## OD-12 — User / membership context and application permissions

**Status: CLOSED.**

**Decision (context resolution): Alternative A — forward the user's own JWT to the Platform's `GET /v1/me`**,
cached per-token with a short TTL (15s in this spike). Na Pista never verifies the JWT's signature itself in
the default path (see ADR-012) and never copies membership into its own database.

**Decision (permissions): local permissions in Na Pista**, keyed by the Platform's global `roleKey`
(`src/authorization/permissions.ts`) — "modelo híbrido" in the brief's list, landing closest to option 3
("Na Pista local permissions") because option 2 (application-scoped Platform permissions) does not exist in
the Platform today (PG-3) and is recorded as optional future work, not built.

| Capability | Platform permission | Na Pista permission | Entitlement |
|---|---|---|---|
| Read a product (human, any authenticated org member) | *(none — membership alone)* | `products.read` | `catalog.enabled` (interim — see OD-14) |
| Create/write a product (human) | *(none)* | `products.write` | `catalog.enabled` + `products.max` |
| Read a product (service credential) | *(n/a — service scope, not a Platform permission)* | *(n/a)* | scope `catalog.read` |
| Write a product (service credential) | *(n/a)* | *(n/a)* | scope `catalog.write` |

**Rationale.**
- *Context resolution*: Option B (a dedicated Platform endpoint purpose-built for "service asks about user X's
  membership in org Y") does not exist; building it is a real Platform change (recorded, not built — see
  `platform-changes-required.md` §PC-3). Option A works with the Platform exactly as it is today, keeps the
  Platform as the single source of truth for membership (no copy to keep in sync), and re-verifies the token
  on the Platform's own terms every time the cache misses.
- *Impersonation risk*: **none beyond what the token itself already allows** — Na Pista sends the caller's
  own bearer token as-is to `/v1/me`; it never substitutes a different token, never widens what the token can
  do. `req.auth.userId` always comes from the Platform's response (the *verified* subject), never decoded
  locally (ADR-012) — a request cannot claim to be a different user than the one whose token it holds.
- *Token forwarding as a pattern*: this is a server-to-server forward of a bearer credential the caller
  already explicitly presented to Na Pista over TLS for exactly this purpose — not a new trust boundary, but
  it does mean the Platform sees Na Pista as the direct caller of `/v1/me` on every cache miss (observability
  note: the Platform cannot distinguish "the human went to Na Pista" from "Na Pista is now polling on their
  behalf" beyond request timing).
- *Audience/issuer*: enforced by the Platform (`EXPECTED_ISSUER`, `aud=authenticated`) exactly as for any
  other caller — Na Pista adds nothing and removes nothing here.
- *Expiration*: enforced by the Platform on every cache-miss call; Na Pista's own local pre-check
  (`auth/jwt.ts`) only ever **rejects early** (never accepts something the Platform would reject) — proven in
  `tests/e2e/auth.test.ts` ("structurally valid but obviously-expired JWT -> 401 via the local fast path").
- *Revocation*: bounded by the cache TTL, never instant, never unbounded — proven live in
  `tests/e2e/authorization.test.ts` (revoke a real membership on the Platform, confirm the Platform itself
  reports it gone, then clear Na Pista's cache and confirm Na Pista enforces it too).
- *Latency/caching*: one Platform round trip per cache miss (~tens of ms locally; real number depends on
  network to the Platform), amortized by the TTL. No caching would mean one round trip per request — rejected
  as unnecessary load for no correctness gain, matching the Platform's own posture on this exact tradeoff for
  entitlements.
- *Complexity*: lower than option B — no new Platform surface, no new contract to keep in sync across three
  repositories (Platform, Na Pista, and whichever other product needs the same lookup next).

**Rejected alternatives.**
- Context: Option B (dedicated Platform introspection endpoint for a *different* user's membership) — real
  Platform work, not built (§PC-3).
- Context: copying membership into Na Pista's own database — rejected outright in F18 (ADR-002/tenancy.md),
  reaffirmed here: it would be a second source of truth for authorization, the exact thing CLAUDE.md §7 rules
  out.
- Permissions: Platform-global permissions reused as-is for Na Pista modules — rejected (PG-3: the Platform's
  20 permissions are organization-administration concepts — `membership.create`, `subscription.manage` — none
  of them are "can create a product"; forcing product-level authorization through them would mean either
  adding product-specific permissions to a Platform meant to stay product-agnostic, or granting `products.write`
  to anyone holding an unrelated permission by coincidence).

**Security implications.** A membership check that always re-derives from the Platform (modulo the TTL) can
never authorize an operation the Platform itself doesn't currently agree the user has access for. The one
residual risk is the TTL window itself — bounded, documented, never silent (R-06 in `f18-review.md`,
re-confirmed here with a real measured mechanism rather than a projected one).

**Performance implications.** One Platform HTTP call per distinct token per TTL window; negligible local CPU
(the permission map is a plain object lookup).

**Platform changes: NONE required to close this decision.** (Option B, a dedicated service-to-service
membership-lookup endpoint, is recorded as optional future work — `platform-changes-required.md` §PC-3.)

**Evidence.** `tests/e2e/authorization.test.ts` (OWNER/STAFF/revoked-membership matrix, live revocation),
`tests/e2e/tenant-isolation.test.ts` (membership cross-org rejection), `tests/e2e/auth.test.ts`.

---

## OD-13 — Cache / entitlement semantics

**Status: CLOSED** (values chosen and tested; treated as a tuning parameter, not a security boundary, so
"closed" here means "a documented, tested default", not "immutable").

**TTLs chosen:** membership 15s, service-credential introspection 15s, entitlements 10s — all short, all in
one place per concern (`platform/membership.ts`, `platform/serviceIntrospection.ts`, `platform/entitlements.ts`),
all with a test-only synchronous clear function so tests never depend on a real sleep to prove post-TTL
behavior (except where a real elapsed-time proof was specifically valuable — see below).

**Semantics decided and unit-tested** (`tests/unit/entitlements.test.ts`, all fail-closed):

| Input | Decision |
|---|---|
| entitlement `true` | enabled |
| entitlement `false` | disabled |
| entitlement absent from the resolved list | disabled — never "assume enabled" |
| entitlement of the wrong shape (string, object, numeric-where-boolean-expected) | disabled ("invalid") |
| `NaN`/`Infinity` for a numeric limit | no usable limit (never coerced, never treated as "unlimited") |
| no granting subscription at all | disabled |
| subscription `canceled` | disabled — proven live against a real subscription (`entitlements.test.ts`, org C) |
| subscription `trialing`/`past_due` | **not tested live** — the Platform's `NOT_CANCELED` predicate treats
  both as granting (README, confirmed by reading `modules/subscriptions/service.ts`), so Na Pista's
  `interpretCapability` (which only reads `subscription !== null` plus the entitlement value, never the
  status string itself) already treats them the same as `active` by construction, not by a special case. No
  live fixture was created in `trialing`/`past_due` specifically because the code path is identical to
  `active` — recorded here rather than silently assumed. |
| Platform unreachable | `503`, never treated as either enabled or disabled — proven live
  (`platform-unavailable.test.ts`) |
| no service credential provisioned for the organization at all | `503` — proven live (`entitlements.test.ts`,
  org C), deliberately distinct from "entitlement absent" (`403`) |

**Cache staleness, measured live, not assumed** (`entitlements.test.ts` "cache" test, `authorization.test.ts`
revocation test): a real subscription cancellation / real membership revocation on the Platform is **not**
reflected by Na Pista until its own cache entry is cleared. In the test suite this is done deterministically
via an exported test-only clear function rather than a real 10–15s sleep, to keep the suite fast; the
mechanism being proven (an in-memory `Map` with an `expiresAt` timestamp, `Date.now()`-gated) is the same
either way — waiting out the real TTL changes nothing about *why* it clears, only *when*. This is the
documented, deliberate tradeoff, not a bug: **never a longer window than the configured TTL, never silent**
(logged as a normal cache-miss round trip, not swallowed).

**Fail-closed rule confirmed structurally, not just by convention:** every interpretation function in
`platform/entitlements.ts` defaults its return value to `enabled: false` / `hasLimit: false` and only flips to
"allow" on an exact, explicit match (`value === true`, `typeof value === "number" && Number.isFinite(value)`).
There is no code path that reaches "allow" through a caught exception, a missing `else`, or an unexpected
value falling through.

**Platform changes: NONE.**

---

## OD-14 — Vocabulary (entitlements, scopes, meters)

**Status: CLOSED for this spike's scope; the underlying seed migration remains future Platform work.**

| Concept | Key | Owner | Status here |
|---|---|---|---|
| Capability (Na Pista's own name) | `products.enabled` | Na Pista | **Target name — not yet backed by Platform seed data** |
| Entitlement (Platform, actually seeded) | `catalog.enabled` | Platform | **Interim key this spike actually gates on** (`middleware/requireCapability.ts`) |
| Entitlement (Platform, actually seeded) | `products.max` | Platform | Used as-is — no rename needed, already matches Na Pista's own vocabulary |
| Service Scope (Platform, actually seeded) | `catalog.read` / `catalog.write` | Platform | Used as-is |
| Service Scope (Platform, actually seeded) | `customer.read` | Platform | Reserved for the future Customers module — not exercised by this spike's Product-only resource |
| Service Scope (Platform, actually seeded) | `usage.write` / `event.publish` | Platform | Used as-is, on the **platform-facing** credential class only (OD-11) |
| Usage Meter (Platform, actually seeded) | `api_requests` | Platform | Reserved for the outbox (not built in this spike — F19 §24 scope) |
| Usage Meter (target, not seeded) | `products` / `appointments` | Na Pista (future Platform seed PR) | Not used by this spike |

**Decision.** Rather than mutate `ul-platform`'s real seed data (`STARTER`/`BUSINESS` plans, used by real
orgs in this same dev database) to invent a `products.enabled` key that doesn't exist yet, this spike
**reuses the existing `catalog.enabled` key as-is** as the interim signal for "the Products capability is
on", and records the eventual rename to `products.enabled` as a documented, deferred seed change
(`platform-changes-required.md` §PC-4) — not something silently done here, per F19 §6's instruction not to
implement Platform changes silently, and not something to skip proving live just because the final name isn't
settled: the *mechanism* (Organization → Subscription → Plan → Plan Entitlement → Effective Entitlement → Na
Pista capability gate) is proven end-to-end regardless of which key name gates it (§OD-13 above,
`entitlements.test.ts`).

**No duplicate/competing keys were created.** `catalog.products` vs `products` (the brief's own example of
what not to do) does not arise here because there is exactly one gating key in play, reused, not duplicated.

**Platform changes: OPTIONAL** — rename `catalog.enabled` to `products.enabled` (or add `products.enabled`
alongside it, deprecate `catalog.enabled`) in the `NA_PISTA` plans' seed data, plus add `products`/`appointments`
usage meters when the corresponding modules are actually built. See `platform-changes-required.md` §PC-4/§PC-5.

---

## OD-16 — Database isolation (RLS)

**Status: CLOSED for this environment. RLS is NOT enabled. Decision may be revisited if the operational
precondition below is met — this is a real technical conclusion, not a placeholder.**

**Decision: do not activate RLS in this deployment.** `WHERE organization_id = ...` enforced through a
repository layer that structurally cannot run without a `TenantContext` (`tenancy.md` §3, `ADR-002`) remains
the **only** enforced isolation mechanism for now.

**RLS, reason.** A real, standalone technical spike (`scripts/rls-spike.ts`, run against the exact Postgres
connection this environment provides — the Supabase Supavisor pooler in transaction mode) found:

1. **The only available application connection role has `BYPASSRLS = true`.** This is Supabase's own
   `postgres` pooler role, not a Na Pista or UL Platform choice — confirmed by querying
   `pg_roles.rolbypassrls` directly (`rolbypassrls=true`, `rolsuper=false`, and it is additionally the
   *owner* of any table it creates). A role with `BYPASSRLS` ignores every RLS policy **unconditionally**,
   and — this is the part worth stating precisely, because it's a common misunderstanding —
   **`ALTER TABLE ... FORCE ROW LEVEL SECURITY` does not change this**: `FORCE` only removes the *table
   owner's* default exemption; it has no effect on a role with `BYPASSRLS`, and none at all on a superuser.
   Measured directly: `ENABLE ROW LEVEL SECURITY` alone left all rows visible to this connection regardless
   of tenant (2/2 rows, no `app.organization_id` set); adding `FORCE ROW LEVEL SECURITY` changed nothing
   (still 2/2); a `SET LOCAL app.organization_id` + policy that should have scoped visibility to 1 row also
   still returned 2/2 — RLS was **not evaluated at all** for this connection, at any point.
2. **A stress test of 200 rapid, alternating-tenant transactions against a small connection pool (max 5),
   using this same bypassing connection, confirmed the same result under load** — not a new finding beyond
   (1) (BYPASSRLS is unconditional, concurrency doesn't change that), but it does rule out "maybe it only
   fails under low load" as an alternative explanation.
3. **RLS was then re-tested with a dedicated, throwaway, least-privilege Postgres role** (`LOGIN`,
   `NOSUPERUSER`, `NOBYPASSRLS`, granted only `USAGE`+`SELECT`+`INSERT` on the one throwaway table — created,
   used, and dropped entirely within the spike run) — **and RLS worked correctly**: `SET LOCAL
   app.organization_id` inside a transaction correctly limited visibility to exactly that organization's row,
   for both test organizations. This is the single most important result: **RLS is not broken as a
   mechanism** — it is simply never evaluated for the specific role this environment's connection string
   currently authenticates as.
4. **Getting that dedicated role to connect through the pooler at all required an operational detail that is
   itself worth recording**: Supabase's Supavisor pooler is multi-tenant and routes purely by parsing the
   connection username as `<role>.<project-ref>` — a bare role name (`na_pista_rls_spike_xxxxx`) was rejected
   outright with `ENOIDENTIFIER: no tenant identifier provided`; only `<role>.<project-ref>` connected
   successfully. Any future least-privilege role must be provisioned with this in mind.
5. **Migrations/admin connections**: with this same bypassing role, a migration-shaped transaction (no GUC
   set at all, as a forgetful script or a background job would produce) sees everything — fine for the role
   this environment actually has, but if a dedicated non-bypassing role were later adopted for the *app*
   while migrations kept using the bypassing role (the natural split: migrations need to see/alter
   everything; the app should not), that split would need to be deliberate and documented, not incidental.

**Risk (of enabling RLS today, with the only available role).** None avoided, none introduced — RLS would be
a no-op with the current connection, so "enabling" it would create a **false sense of a second layer of
protection that isn't actually there**. That is a real risk in itself: a reviewer or a future engineer reading
`ENABLE ROW LEVEL SECURITY` in a migration could reasonably assume it does something.

**Risk (of the current app-level-only approach).** A bug that forgets a `WHERE organization_id = ...` (or,
in this spike's design, a call into `repository.ts` that somehow bypasses `assertTenant` — structurally
prevented, not just conventionally avoided, per `tenancy.md` §3 layer 3) would have no second layer to catch
it. This is the real, standing argument for eventually provisioning the dedicated role and enabling `FORCE
ROW LEVEL SECURITY` for defense in depth — recorded as future work, not done now because it requires
operational provisioning (a persistent role, a credential-rotation story for it, and updating the deployment
connection string) beyond a spike's scope.

**Precondition to revisit:** provision a dedicated, least-privilege, non-`BYPASSRLS` Postgres role for Na
Pista's real application connection (not the Supabase project's own `postgres` pooler role), using the
`<role>.<project-ref>` Supavisor username convention, and repeat this exact spike's concurrency stress test
(§OD-16 point 2 above) against *that* role specifically — the 200-transaction stress test was only run
against the bypassing role in this pass; the dedicated role's isolation was proven correct for two sequential
reads, not yet stress-tested under the same concurrent load. When both are green, enabling `ENABLE` +
`FORCE ROW LEVEL SECURITY` becomes a real, evidence-backed second layer rather than a placebo.

**Platform changes: NONE** — this is entirely about Na Pista's own database connection; it has no bearing on
`ul-platform`'s database at all.

**Evidence.** `scripts/rls-spike.ts` and its full output — reproducible, idempotent, cleans up its own
throwaway schema/role every run.
