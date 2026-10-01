# F29A — Platform credential persistence & runtime readiness — Report

Plan: [`f29a-implementation-plan.md`](f29a-implementation-plan.md). Architecture summary:
[`architecture.md` §5.1](architecture.md).

## 1. Problem

F29 gap **G1**: Na Pista's outbound calls to UL Platform (entitlements, usage) authenticate with the
organization's *platform-facing* credential, which lived only in an in-memory `Map`
(`src/platform/serviceAuth.ts`). Nothing in `src/` populated it — only tests and the `mv:server`
launcher did — so a plain `npm run dev`/`npm start` answered every entitlement-gated tenant request
with `503 UPSTREAM_UNAVAILABLE`, and any restart lost every credential.

## 2. Existing architecture (as inspected)

- Two runtime consumers of the registry: `platform/entitlements.ts` (fail closed, 503) and
  `platform/usage.ts` (skip, never breaks the operation).
- Registry writers: 20 e2e files/helpers and `scripts/manual-validation-server.ts`. The `spikes/` copy is
  a frozen F19 spike (not runtime) and was left untouched.
- The credential is a UL Platform organization-scoped API key for application `NA_PISTA`, minted by the
  Platform; Platform API keys have no environment dimension.
- Na Pista has no organizations table (identity lives in the Platform, ADR-002); tenant tables carry
  `organization_id`. Audit: `na_pista.audit_events` via `modules/audit/service.ts`.
- No encryption key existed in Na Pista's env schema. `.env` contained UL Platform's
  `WEBHOOK_SECRET_ENCRYPTION_KEY` (read by no Na Pista code) — deliberately **not** reused.

### Registry usage classification

| Usage | Class | After F29A |
| --- | --- | --- |
| `platform/entitlements.ts`, `platform/usage.ts` | A — production runtime | now `resolvePlatformCredential` (PostgreSQL) |
| 20 e2e test files/helpers (`registerServiceCredential`) | B — test fixture | unchanged; honoured as a test override |
| `scripts/manual-validation-server.ts` | C — dev bootstrap | unchanged, documented as no longer needed |
| `spikes/platform-integration/**` | D — obsolete (frozen F19 spike) | untouched |

## 3. Credential persistence design

- One **ACTIVE** credential per organization (enforced by the database), history kept as REVOKED rows.
- Single runtime resolver; single provisioning service; no credential logic in controllers.
- The in-memory registry is demoted to an explicit override consulted **only** when no DB row exists for
  the organization **and** `NODE_ENV !== "production"` — so production never reads it and a persisted
  REVOKED credential can never be bypassed through it.

## 4. Encryption design (`src/security/credentialCrypto.ts`)

- AES-256-GCM (Node `crypto`; no custom cryptography), fresh 12-byte IV per encryption, 16-byte tag —
  the convention ul-platform already uses for webhook secrets, re-implemented locally (independent repo).
- Envelope `v1:<iv>:<authTag>:<ciphertext>` (base64url) — versioned for future format/key rotation.
- **AAD** = `na-pista/platform-credential/v1/<organizationId>`: a ciphertext moved to another
  organization's row fails authentication (tested).
- Key: `NA_PISTA_CREDENTIAL_ENCRYPTION_KEY`, base64 of 32 bytes, Na Pista-only. Malformed → startup fails
  everywhere; missing → startup fails in production; in development/test every use fails closed
  (`KEY_MISSING`). Errors carry a reason code only.

## 5. Database schema (migration `0010_platform_credentials`)

`na_pista.organization_platform_credentials`: `id`, `organization_id`, `platform_api_key_id`
(Platform's public key id, UNIQUE), `encrypted_credential`, `status` (`ACTIVE`/`REVOKED`),
`revoked_at`, `created_at`, `updated_at`.

- `org_platform_credentials_one_active_per_org`: partial unique index `(organization_id) WHERE status = 'ACTIVE'`.
- CHECKs: status vocabulary; `(status = 'REVOKED') = (revoked_at IS NOT NULL)` (repo convention);
  `encrypted_credential LIKE 'v1:%'` (plaintext can't be written by mistake).
- No environment column (Platform keys have none; one DB per deployment). No FK (no organizations table);
  ownership = `organization_id NOT NULL` + scoped queries + AAD binding.

## 6. Runtime resolution flow

```text
Request → authenticate → requireTenantContext (membership / service identity cross-check)
  → requireCapability → fetchEntitlements(orgId)
      → resolvePlatformCredential(orgId)          [modules/platformCredentials/resolver.ts]
          validate UUID → load row → ACTIVE? → decrypt (AAD = orgId)
          any failure → 503 UPSTREAM_UNAVAILABLE, reason code logged, NO Platform request
      → Platform GET …/entitlements  (Authorization: Bearer <plaintext>, only here)
  → controller → service → repository → PostgreSQL → usage write (same resolver)
```

Failure reasons (logged as `platform_credential.unavailable` with `organizationId`, `reason`,
`requestId` only): `INVALID_ORGANIZATION`, `NOT_PROVISIONED`, `REVOKED`, `KEY_MISSING`,
`DECRYPTION_FAILED`, `STORE_UNAVAILABLE` (DB errors are never forwarded — they can carry connection details).

## 7. Provisioning flow

`provisionPlatformCredential({ organizationId, credential }, { actor, replaceActive? })`:

1. The **real Platform** identifies the key (`GET /v1/service/me`): must be valid, belong to this
   organization, and be a `NA_PISTA` key — otherwise `VALIDATION_ERROR`, nothing stored.
2. Encrypt (fails closed without a key, before any write).
3. One transaction: same key already ACTIVE → `UNCHANGED` (idempotent); different ACTIVE key →
   `CONFLICT` unless `replaceActive` (explicit rotation: revoke + insert atomically → `ROTATED`); same key
   previously REVOKED → `CONFLICT` (never resurrected); otherwise insert → `PROVISIONED`. Audit in the
   same transaction. A concurrent race is settled by the unique indexes and re-read.

Never triggered by a GET or at startup. **Integration point:** Na Pista cannot mint Platform keys; the
natural hook is subscription activation on the Platform (webhook or OWNER "activate Na Pista" flow)
calling this service. Today: `npm run credentials:provision` (dev bootstrap, reads the git-ignored
fixture, prints organization ids and outcomes only).

## 8. Revocation

`revokePlatformCredential(organizationId, { actor })`: ACTIVE → REVOKED (+ `revoked_at`), audited. The
resolver refuses REVOKED rows immediately for new Platform requests; an entitlement decision already cached
in a running process can still apply for up to its 10s TTL (OD-13). This revokes Na Pista's **use** of the
key only — the key must also be revoked on the Platform by the organization's OWNER.

## 9. Tenant isolation

Query scoping by `organization_id`; resolver only receives the organization validated by
`requireTenantContext`; AAD binding at rest; one Platform key can back only one row (UNIQUE). Tested:
A→A, B→B, no cross resolution; B's ciphertext copied into A's row fails (`DECRYPTION_FAILED`); a key
attributed by the Platform to another organization is refused at provisioning.

## 10. Security considerations

- Plaintext exists only inside `resolvePlatformCredential`'s return → the outbound Authorization header.
  No route returns it; status helpers (`getPlatformCredentialStatus`) expose metadata only
  (configured/status/timestamps). No Console/API surface was added.
- Never logged: tests assert plaintext, ciphertext and key are absent from logs, errors, audit rows,
  API responses and the server's own output.
- Audit metadata: `platformApiKeyId` (public id, documented safe by the Platform), status, reason.
- Local key generated into the git-ignored `.env` (never printed, never committed). `.env.example`
  documents the variable empty.

## 11. Migration

Generated with drizzle-kit, purely additive (one table, 3 indexes, 3 CHECKs). Applied to the configured
database: journal 10 → 11; a second `migrate` was a no-op; every pre-existing table kept its rows (counts
only increased, from a concurrently running test suite — none decreased). Rollback (forward-only repo
convention): `DROP TABLE na_pista.organization_platform_credentials;` — nothing depends on it — then remove
the journal entry.

## 12. Tests

| Suite | Result |
| --- | --- |
| `tests/unit/credentialCrypto.test.ts` (new, 9) | 9/9 — round trip, fresh IV, tampered ct/tag/IV, AAD cross-org, wrong key, malformed/unsupported version, missing/short key, no secret in errors |
| `tests/integration/platformCredentials.test.ts` (new, 16, real PostgreSQL) | 16/16 — persistence, retrieval, missing/invalid fail closed, revocation (override cannot bypass), no resurrection, isolation, AAD swap attack, wrong org/app refused, idempotency, DB-enforced single ACTIVE, rotation, missing key, concurrent resolution, concurrent provisioning race, audit contains no secret, no secret in logs/errors, **restart simulation** (fresh process, empty registry) |
| `tests/e2e/platform-credentials-runtime.test.ts` (new, 5, **real Platform + real PostgreSQL**) | 5/5 — see §13 |
| Unit (all) | 219/219 (210 existing + 9) |
| Integration (all) | 206/206 (190 existing + 16 new), real PostgreSQL |
| Typecheck / build | pass / pass |
| Lint | 18 errors, **all pre-existing** (`no-explicit-any` in 10 e2e helper files, present at HEAD before F29A); 0 in F29A files |

**Existing E2E suites (F20–F29) cannot currently run — pre-existing, independent of F29A.** Their
fixtures hold user access tokens that have expired (Platform `/v1/me` → 401). Verified by running
`tests/e2e/entitlements.test.ts` both on this branch **and on pristine HEAD in a temporary worktree**: identical
`401` failures at authentication, before any credential code runs. Re-provision with ul-platform's
`f2x:provision` scripts to run them again; F29A keeps their in-memory credential injection working.

## 13. Real infrastructure validation

`tests/e2e/platform-credentials-runtime.test.ts`, against the configured UL Platform and PostgreSQL, no
mocks, using the F20 organization A and its two existing Platform-minted keys (nothing new minted):

1. Provision orgA's platform-facing key → the **real Platform** introspects it; only the encrypted form is stored.
2. Start `src/server.ts` as a **separate process**; this process registered **nothing** in memory
   (asserted) → inbound request with the org's integration key → Platform introspection → **persisted
   credential resolved and decrypted** → Platform entitlements → `GET …/products` **200**; `POST …/products`
   **201** with the usage write accepted by the Platform.
3. **Restart** (new process) → still **200**.
4. Revoke → new process → **503 UPSTREAM_UNAVAILABLE**, reason `REVOKED` logged.
5. No platform-facing secret, integration secret, ciphertext or key in any response or server output.

The test refuses to run if orgA already has a persisted row, and removes its own row afterwards (audit rows
remain, append-only).

The dev bootstrap (`npm run credentials:provision`) was run against the manual-validation fixture: both
organizations' keys were **rejected by the Platform** (`401 Invalid API key` — those organizations were torn
down), so nothing was stored — the fail-closed path working as designed. To use `npm run dev` with real
Console data: `npm run mv:provision` in ul-platform, then `npm run credentials:provision` here.

## 14. Remaining limitations

- Key management is an env var (no KMS); rotating `NA_PISTA_CREDENTIAL_ENCRYPTION_KEY` requires
  re-provisioning (the `v1` envelope reserves room for a multi-key scheme).
- No automatic provisioning on subscription activation yet (integration point documented in §7).
- Revocation in Na Pista does not revoke the key on the Platform; Platform-side revocation surfaces as a
  Platform 401 → 503 (fail closed) but is not auto-reflected in Na Pista's row status.
- Cached entitlement decisions may outlive a revocation by ≤10s (existing OD-13 TTL).
- No credential status endpoint/UI (not required by the Console today; `getPlatformCredentialStatus` is ready).
- Existing E2E suites need fresh fixtures (expired tokens) — see §12.

## Quality gate

| Item | Status |
| --- | --- |
| Credentials persist in PostgreSQL · encrypted at rest | ✅ |
| Plaintext never reaches frontend / logs | ✅ (tested) |
| Runtime no longer depends on the in-memory registry | ✅ (real E2E, registry empty) |
| Restart preserves Platform connectivity | ✅ (real E2E + integration restart simulation) |
| Tenant isolation · revocation · missing fails closed | ✅ |
| Real configured infrastructure tested | ✅ |
| Migration passes | ✅ |
| Typecheck · unit · integration · build | ✅ · ✅ · ✅ · ✅ |
| New E2E | ✅ |
| **Lint** | ❌ 18 pre-existing errors (none from F29A) |
| **Existing F20–F29 E2E** | ⚠️ not runnable — pre-existing expired fixture tokens (proven on HEAD) |
| Documentation · no secrets committed/printed | ✅ |

**F29A status: runtime readiness achieved and proven on real infrastructure; not marked COMPLETE** while
lint (pre-existing) fails and the existing E2E suites await fresh fixtures.
