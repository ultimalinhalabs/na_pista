# F30 — Integration Contract Hardening: report

Branch `f30-integration-contract` (from `f29a-platform-credential-persistence` @ `ce50839`, because F30 builds on F29A's
credential store). Plan and findings: [`f30-audit.md`](f30-audit.md). Decisions: ADR-051 … ADR-057.

## 1. Audit summary

57 routes before F30 (56 authenticated + health), one consistent auth chain, a consistent `{data}`/`{error}`
envelope. Defects **measured** against the running app before any change:

| Defect | Before | After |
| --- | --- | --- |
| Malformed JSON body | `500 INTERNAL_ERROR`, no `X-Request-ID` | `400 VALIDATION_ERROR` + `X-Request-ID` |
| Malformed id in a path (`/products/not-a-uuid`) | reached PostgreSQL (`22P02`) → `500` | `400`, `details: [{location:"path", path:"productId"}]` |
| Unmatched route | Express **HTML** 404 | JSON `404 NOT_FOUND` (anonymous callers still get `401` first) |
| Lists | silently truncated at `limit`; no way to fetch more or know a total | `page`/`pageSize` + `pagination.total` |
| List ordering | 8 of 9 lists ordered by a non-unique timestamp only | `…, id` tiebreak everywhere |
| `zeroStock=false` | meant **true** (`z.coerce.boolean`) | exactly `true`/`false`; `false` = no filter |
| `q=%` / `q=_` | wildcards (matched everything) | matched literally |
| Validation errors | "Invalid request payload", no field information | same message + `details[]` |
| OpenAPI | promised by ADR-005, absent | generated, validated, served, committed |

`api-boundary.md` also documented features that never existed (cursor pagination, multi-field sort,
`Idempotency-Key`, `/v1/health/ready`, rate limiting); it now says what is real.

## 2. Decisions

| ADR | Decision |
| --- | --- |
| 051 | Page-based pagination with totals, additive envelope; per-endpoint defaults unchanged; `limit` kept as alias. Supersedes ADR-005's never-implemented cursor clause |
| 052 | Per-endpoint filter allowlists (existing names kept, `q` not renamed); single-field `sort`/`order` allowlists mapped to columns in code; `id` tiebreak |
| 053 | Error contract hardening (above), additive `details`, message unchanged (the Console hides it) |
| 054 | OpenAPI 3.1 generated from the existing Zod request schemas + new strict Zod response schemas; Zod's native `toJSONSchema` (no runtime dependency); test-only validator `@readme/openapi-parser` |
| 055 | `GET …/audit-events`: `audit.read` (OWNER/ADMIN), humans only, behind the capability gate, defence-in-depth redaction |
| 056 | `GET …/platform-credential`: `integrations.read` (OWNER/ADMIN), humans only, **not** behind the capability gate (which itself needs the credential) |
| 057 | No Na Pista webhook API: the UL Platform owns webhooks; Na Pista publishes no events yet; delivery history is not readable anywhere |

## 3. API contract changes (all additive or fixes of already-failing requests)

- **New:** `GET /v1/openapi.json`, `GET /v1/organizations/{id}/audit-events`, `GET /v1/organizations/{id}/platform-credential`.
- **New permissions:** `audit.read`, `integrations.read` (OWNER, ADMIN).
- **Lists (9):** `+page`, `+pageSize`, `+sort`/`+order` (where allowlisted), response `+pagination`. `data` unchanged.
- **Errors:** `+details`; `+PAYLOAD_TOO_LARGE 413`; status fixes listed in §1.
- **Behaviour fixes:** `zeroStock=false`; literal `%`/`_` in `q`; deterministic order.
- **Not changed:** every `data` shape, every success status, every existing error code, default page sizes, default orders.

## 4. OpenAPI

60 operations / 37 paths / 27 component schemas. Source: `src/contract/{schemas,operations,openapi}.ts`.
Request schemas = the handlers' own Zod objects; response schemas are strict Zod objects also used by the E2E contract
test. Published at `GET /v1/openapi.json` and `docs/api/openapi.json` (`npm run openapi:generate`).

Tests: valid against the official OpenAPI 3.1 schema; committed file == generated (drift check); **route registry ==
Express router in both directions** (mutation-tested: removing a documented route and adding a phantom one each
fail); unique operation ids; every authenticated operation declares a permission; no secret-bearing field names.
Each operation documents its permission (`x-na-pista-permission`), scope (`x-na-pista-scope`), capability, error codes.

## 5. Pagination

9 lists + audit. One condition builder per list feeds both the page query (`LIMIT/OFFSET`) and its `count(*)`, so a
total can never use a different tenant filter than the rows. Internal list functions keep their signatures (no churn
for internal callers); thin `…Page` service functions serve HTTP. Defaults/maxima unchanged (50/100; appointments
200/500). Not paginated, by decision: bounded sub-collections and computed views (ADR-051).

## 6. Filtering & sorting

No new filters on business lists. Sorting allowlists: catalogue lists `createdAt|name`; orders `createdAt|updatedAt`;
inventory `updatedAt|quantity`; movements/appointments/audit fixed. Values outside the allowlist are rejected by a Zod
enum before any query is built.

## 7. Credential status

Reuses F29A's `getPlatformCredentialStatus()` unchanged: `{ configured, status, createdAt, updatedAt, revokedAt }`.
DB-only (never calls the Platform, never decrypts). Proven readable while the capability gate fails closed.

## 8. Audit read API

Filters `action`, `actorType`, `resourceType`, `resourceId`, `from`, `to` (indexed equality/range only), newest
first, paginated, `organizationId` not repeated per event, recursive key-based redaction. Pinning `to` gives stable
paging of the growing log.

## 9. Webhook visibility

Documented, not re-implemented (ADR-057, `docs/api/webhooks.md`): Platform routes and permissions, metadata
visible (no URL, no secret after creation), signature scheme as implemented by the Platform, at-least-once delivery.
Explicit limitations: Na Pista publishes no events yet; delivery history has no read API. An E2E test proves Na Pista
exposes no webhook route.

## 10. Documentation

`docs/api/`: README (index), quickstart (10 steps + two complete custom-UI examples), authentication, errors,
pagination, filtering, sorting, webhooks, audit, credentials, categories-api, `openapi.json`; module docs updated for
pagination/sorting and the `zeroStock` fix. Every factual claim was checked against code (corrections made while
writing: archive audit action is `product.deleted`; the Platform has no organization-level audit read API;
`LIMIT_EXCEEDED`/`MODULE_DEPENDENCY_UNMET` are never raised and are not documented as live).

## 11. Console compatibility

The Console reads only `json.data`, sends `limit` (still honoured), sends only `zeroStock=true`, hides the unchanged
validation message, and calls the Platform directly for webhooks/API keys — **compatible with F30 without changes**.
One improvement migrated to the public contract (separate Console commit): dashboard counts now use
`pagination.total` (exact) instead of list length capped at 100 ("100+"), with fewer rows fetched. **Deploy order:
API first** — against a pre-F30 API those three counters would show "—".

## 12. Security

Proven over real HTTP (real UL Platform, real PostgreSQL) in `tests/e2e/contract.test.ts` and on real PostgreSQL in
`tests/integration/{listing,auditRead}.test.ts`:

| Requirement | Evidence |
| --- | --- |
| Org A cannot read Org B's pagination results or totals | listing: rows **and** `total` tenant-scoped, page arithmetic cannot reach B; E2E: B's product list contains only B |
| Org A cannot read Org B's audit | auditRead: rows and totals isolated; E2E: owner of B → 403 on A's audit; B's own audit has none of A's resources |
| Org A cannot read Org B's credential status | E2E: owner of B → 403 |
| Org A cannot read Org B's webhook metadata | Na Pista exposes no webhook route (E2E: 404); webhooks are Platform-scoped per organization (ADR-057) |
| Staff cannot perform administrative actions / read integration metadata | E2E: STAFF and MANAGER → 403 on audit and credential status; unit: role map |
| Integration keys cannot read governance metadata | E2E + unit: a `catalog.read`+`catalog.write` key → 403 on audit and credential status |
| Secrets never in responses | E2E: every response body of the suite scanned for the three fixture key secrets and for ciphertext/key markers — none; OpenAPI contains no secret-bearing field |
| Secrets never in logs | F29A log-safety tests unchanged and passing; F30 adds no logging of request bodies, tokens or credential values |
| Query parameters cannot become SQL identifiers | sort values pass a Zod enum and map to columns in code; injection-shaped values → 400 (unit, integration, E2E) |
| Pagination cannot bypass tenant filters | one condition builder per list feeds both page and count; `organization_id` is always its first predicate |
| Malformed ids / bodies never reach the database or leak internals | path UUIDs validated before tenant resolution; malformed JSON → 400; error bodies never echo submitted values |

## 13. Performance

Measured, not assumed: 5 000 products and 5 000 audit events in one throwaway organization, `EXPLAIN ANALYZE` of the
exact queries F30 generates, on the configured (remote) PostgreSQL:

| Query | DB time | Plan |
| --- | --- | --- |
| products page 1 (`createdAt desc, id`) | 0.84 ms | Index Scan `products_org_created_idx` + incremental sort |
| products page 100 (offset 4 950) | 5.26 ms | same |
| products `count(*)` | 1.57 ms | Seq Scan |
| products `sort=name` | 4.28 ms | Seq Scan + Sort |
| products `q` (ILIKE substring) | 11.24 ms | Seq Scan |
| audit page 1 | 0.69 ms | Index Scan `audit_events_org_created_idx` |
| audit `action` filter | 0.63 ms | same |
| audit filtered `count(*)` | 1.87 ms | same |

End-to-end service calls (page + count in parallel, including network): 385–390 ms warm (1.38 s cold, first call),
dominated by round trips to the remote database, not by the queries. No N+1: every list is one page query plus one
count. **No new index added** — the sequential scans stay in single-digit milliseconds at this size; a
`(organization_id, name)` index is the first candidate if name sorting becomes hot. The 5 000 synthetic products were
deleted afterwards; the 5 000 synthetic audit rows were left in place (audit is append-only by design) under a random
organization id.

## 14. Tests

| Suite | F30 additions |
| --- | --- |
| Unit | `errorContract` (7) — malformed JSON, 413, JSON 404, 401-before-404, `details` shape, no value echo · `openapi` (5) — spec valid vs. official 3.1 schema, committed == generated, router == registry both ways (mutation-tested), unique ids, no secret fields · `humanPermission` (5) |
| Integration (real PostgreSQL) | `listing` (11) — full coverage, determinism on equal timestamps (mutation-tested), defaults, `limit` alias, invalid pages, tenant isolation of rows and totals, sort allowlist + injection shapes, literal `%`/`_`, customer multi-field `q`, `zeroStock` true/false/invalid, join-based count, movements, orders · `auditRead` (5) — pagination, every filter, `to` pinning, tenant isolation, redaction at depth |
| E2E (real Platform + PostgreSQL) | `contract` (11) — every resource exercised as a custom UI would, each response validated against the published strict schemas; pagination/sorting/error contract over HTTP; credential status missing → ACTIVE → REVOKED and access matrix; audit access matrix; no webhook proxy; no secret in any response |

Changed existing tests (disclosed): five unit assertions that read the schema-level default `limit` now assert the
same defaults (50/200) through `pageRequest()`, where the default moved; three E2E suites got a bounded pool
teardown (§15) — no assertion changed.

## 15. Results (code at `7f86f61`)

| Gate | Result |
| --- | --- |
| Unit | **236/236** |
| Integration (real PostgreSQL) | **224/224** (208 pre-F30 + 11 listing + 5 audit read) |
| E2E, complete F20–F30 (13:41–14:46Z, fresh fixtures) | **238/239** — 1 failure, investigated below, then fixed |
| ↳ `contract.test.ts` (F30) | **11/11** |
| Re-run of the three suites with the teardown fix | **15/15** (customers-lifecycle 27 s, inventory-lifecycle 80 s, audit-and-usage 28 s) |
| Typecheck (src + tests) · build | pass · pass |
| Lint | **18 errors, all pre-existing** (`no-explicit-any` in e2e helpers; the 2 in a file F30 touched are older lines, verified by `git blame`); **0 new**, 0 warnings |
| OpenAPI | valid OpenAPI 3.1; 60 operations; drift check passes |
| Console (separate repo) | 166/166 tests, typecheck, lint, build pass |

**The one E2E failure — `customers-lifecycle`, file-level 90 s timeout.** All 6 tests passed (~20 s); the time went
to the teardown `await queryClient.end()` (no timeout) against the remote pooler. Isolated runs: 112 s (timeout) and
92 s on F30 code, **112 s (timeout) and 91 s on pre-F30 code `ce50839`** — pre-existing, class E (harness
timeout), unrelated to F30. Fixed in `7f86f61` for the three suites that still ended the pool without a timeout
(the F29A suites already use `end({ timeout: 5 })`); the same root cause explains F29A's earlier
`inventory-lifecycle` timeout.

Earlier in F30 the first contract-E2E run failed 2 tests, both test-side assumptions, both corrected without weakening
the property: (1) "business routes 503 immediately after revocation" ignored the documented ≤10 s entitlement cache
(fail-closed after expiry is proven by F29A's runtime test; "status readable while the gate fails" is proven with
orgC); (2) the test deleted a credential row directly in the database without telling the process (a real service
call invalidates the row cache).

### Quality gate

| Item | Status |
| --- | --- |
| Public API has validated OpenAPI | ✅ |
| Collection endpoints paginated consistently where appropriate | ✅ (9 lists + audit; bounded sub-collections by decision) |
| Pagination is tenant-safe | ✅ (rows and totals, tested) |
| Filtering conventions documented | ✅ |
| Sorting is allowlisted | ✅ |
| Credential status safely observable | ✅ |
| Audit safely readable | ✅ |
| Webhook capabilities documented and observable where supported | ✅ documented; nothing Na Pista-side to observe yet (no events, no Platform delivery-history API) |
| No secrets exposed | ✅ |
| API documentation matches implementation | ✅ (claims checked against code; contract generated) |
| Quickstart works using public contracts | ✅ (every endpoint it uses is exercised by the E2E contract suite) |
| Console continues to work | ✅ (unchanged API usage still valid; dashboard improvement tested) |
| Custom integration example works | ✅ (contract E2E) |
| Unit · Integration · E2E | ✅ · ✅ · ✅ (238/239 → harness fix → 15/15 re-run) |
| Typecheck · Build | ✅ · ✅ |
| No new lint errors | ✅ |
| No undocumented breaking changes | ✅ (every change listed in §3; ADRs 051–057) |
| Repository is clean | ✅ (after the report commit) |

## 16. Limitations / deferred work

- Offset pagination: rows inserted while a client pages can shift later pages (documented workaround; audit: pin `to`).
- No ADMIN fixture exists: ADMIN's access to audit/credential status is proven by the role-map unit tests, not over HTTP.
- Webhooks: Na Pista event publication (ADR-050) and a Platform delivery-history read API are both prerequisites for
  observable Na Pista webhooks.
- No `Idempotency-Key` (ADR-049 not implemented); no rate limiting in Na Pista.
- The Console does not surface the audit trail or credential status yet (APIs exist).
- Sub-collections (`schedule/exceptions` grows with history) are not paginated by design; revisit if they grow large.
