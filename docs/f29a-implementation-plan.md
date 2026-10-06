# F29A — Implementation plan: Platform credential persistence & runtime readiness

Status: plan, written after inspection and before any code change.

## 1. What was inspected (and what it showed)

| Area | Finding |
| --- | --- |
| Registry | `src/platform/serviceAuth.ts`: a module-level `Map<organizationId, secret>` with `register/get/clear`. |
| Runtime consumers | **Only two**: `platform/entitlements.ts` (`fetchEntitlements` → throws 503 when missing) and `platform/usage.ts` (`recordUsage` → skips silently when missing). Nothing in `src/` populates the map. |
| Effect | A plain `npm run dev`/`start` answers every entitlement-gated tenant request with `503 UPSTREAM_UNAVAILABLE` — F29 report gap **G1**. |
| Who writes the registry | 20 e2e test files/helpers (fixtures from `.fixtures/f2x-fixtures.json`) and `scripts/manual-validation-server.ts` (dev launcher). The `spikes/` copy is a frozen F19 spike — not runtime. |
| Credential shape | A UL Platform **organization-scoped API key** for application `NA_PISTA` (`ulk_<keyId>.<secret>`), minted by the Platform's own API (ul-platform `mv:provision`/`f2x:provision`). Platform-side it is `api_keys(id, organization_id, application_id, status ACTIVE/REVOKED, expires_at)` — **no environment dimension**. |
| Introspection | Platform `GET /v1/service/me` (already used by `serviceIntrospection.ts`) returns `{ apiKeyId, application, organizationId, scopes }` for a credential — lets Na Pista verify ownership before storing one. |
| Organizations | Na Pista has **no organizations table** (identity lives in the Platform, ADR-002); every tenant table carries `organization_id uuid NOT NULL`. `organization_settings` is the 1:1 precedent. |
| DB conventions | `pgSchema("na_pista")`, `timestamps` helper, `CHECK` constraints for status/timestamp coherence (e.g. `appointments_no_show_at_matches_status`), partial unique indexes, drizzle-kit migrations in `drizzle/migrations`, meta in `na_pista_drizzle_meta`. 10 migrations applied on the real DB. |
| Env | `src/config/env.ts` (Zod). No encryption key exists in Na Pista's schema. `.env` holds a `WEBHOOK_SECRET_ENCRYPTION_KEY` that **no Na Pista code reads** — it is UL Platform's variable; it will **not** be reused (key separation). `publish_api_key`/`secret_api_key` are Supabase keys, not Platform credentials. |
| Crypto precedent | ul-platform `modules/webhooks/crypto.ts`: AES-256-GCM, 12-byte IV, base64 32-byte key from env, `iv:tag:ciphertext`. Na Pista will follow the same convention (own copy — no cross-repo import) and add a version prefix + AAD. |
| Audit | `modules/audit/service.ts` → `na_pista.audit_events` (`actor_type` user/service, `actor_id` text, metadata jsonb). Reusable as-is. |
| Subscription lifecycle | Owned by the Platform. Na Pista has no activation hook today (no webhook consumer). |

## 2. Design

### 2.1 Table `na_pista.organization_platform_credentials`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `organization_id` | uuid NOT NULL | the Platform Organization (tenant) |
| `platform_api_key_id` | uuid NOT NULL, UNIQUE | Platform's public key id (from introspection). Not secret; lets rotation/audit correlate with the Platform. UNIQUE: one Platform key can never be stored for two rows/orgs. |
| `encrypted_credential` | text NOT NULL | versioned AES-256-GCM envelope — never plaintext |
| `status` | text NOT NULL | `ACTIVE` \| `REVOKED` (CHECK) — same vocabulary as the Platform's `api_keys` |
| `revoked_at` | timestamptz NULL | CHECK `(status = 'REVOKED') = (revoked_at IS NOT NULL)` |
| `created_at`, `updated_at` | timestamptz | `timestamps` helper |

- **Partial unique index** `(organization_id) WHERE status = 'ACTIVE'` → the runtime can never see two active credentials for one organization; a concurrent double-provision loses at the database.
- No environment column: Platform keys have no environment; each Na Pista deployment has its own database.
- Tenant ownership: no organizations table to reference, so ownership is enforced by (a) `organization_id NOT NULL` + every query filtering by it, and (b) **AAD binding** (below) so a ciphertext copied into another organization's row fails to decrypt.

### 2.2 Encryption — `src/security/credentialCrypto.ts`

- AES-256-GCM (Node `crypto`, no custom crypto), fresh 12-byte IV per encryption.
- Envelope: `v1:<iv>:<tag>:<ciphertext>` (base64url parts).
- **AAD** = `na-pista/platform-credential/v1/<organizationId>`: the ciphertext is cryptographically bound to its organization.
- Key: new env var **`NA_PISTA_CREDENTIAL_ENCRYPTION_KEY`** (base64, must decode to 32 bytes). Validated in `env.ts`: malformed → startup error in every environment; **missing → startup error when `NODE_ENV=production`** (fail closed), allowed in development/test where crypto calls then fail closed at use time.
- API: `encryptCredential(plaintext, organizationId)`, `decryptCredential(envelope, organizationId)`; key injectable for tests.

### 2.3 Repository + resolver — `src/modules/platformCredentials/`

- `repository.ts`: `findCredentialRow(orgId)` (active-or-latest), `insertActive`, `revokeActive` — every query scoped by `organization_id`.
- `resolver.ts`: **`resolvePlatformCredential(organizationId)`** — the single runtime entry point:
  1. validate `organizationId` is a UUID;
  2. load the organization's row;
  3. row exists → `ACTIVE` required, decrypt with AAD, return plaintext; `REVOKED`/decrypt failure/key missing → fail closed;
  4. no row → test-only override (2.5) if allowed, else fail closed.
  Every failure throws `UpstreamUnavailableError("Platform credential unavailable for this organization")` — same 503 the code already returns — and logs only `{organizationId, reason, requestId}`. The plaintext never leaves `platform/*`.
- `service.ts` (provisioning): `provisionPlatformCredential({ organizationId, credential }, { actor, replaceActive? })`:
  1. introspect the credential with the Platform (`GET /v1/service/me`) — must be valid, `organizationId` must match, `application` must be `NA_PISTA`;
  2. in one transaction: same key already ACTIVE → **no-op (idempotent)**; a different ACTIVE key → `ConflictError` unless `replaceActive` (explicit rotation: revoke old + insert new atomically); the same key previously REVOKED → `ConflictError` (never silently resurrected);
  3. insert encrypted row + audit `platform_credential.provisioned` (or `.rotated`) in the same transaction.
  `revokePlatformCredential(organizationId, { actor })` → ACTIVE→REVOKED + audit `platform_credential.revoked`. Audit metadata: `platformApiKeyId`, status — never the secret or ciphertext.

### 2.4 Runtime wiring

`platform/entitlements.ts` and `platform/usage.ts` call `resolvePlatformCredential` instead of `getServiceCredential`. Entitlements: still fail closed (503). Usage: still never breaks the business operation (logs `usage.write.skipped_no_credential` with the reason).

### 2.5 Compatibility for existing test fixtures

`serviceAuth.ts` stays as an explicit **test/dev override store** (renamed semantics, same API so 20 e2e files and `mv:server` keep working). The resolver consults it **only when (a) no database row exists for the organization and (b) `NODE_ENV !== "production"`**. Consequences: production can never use it; a DB `REVOKED` row can never be bypassed by an override; normal runtime needs no registration.

### 2.6 Provisioning / bootstrap

- No automatic creation on GET, no creation at startup, no overwrite.
- Integration point (documented, not built): subscription activation on the Platform → Platform webhook or an OWNER-initiated "activate Na Pista" call → `provisionPlatformCredential`. Na Pista cannot mint Platform keys itself (it holds no user/admin authority for that).
- Dev bootstrap: `scripts/provision-platform-credentials.ts` (`npm run credentials:provision`) — reads the git-ignored `.fixtures/manual-validation.json` (or `--fixtures <file>`), provisions each organization's platform-facing credential through the service above (so it is introspected + encrypted + audited), prints only organization ids and outcomes.
- Local key: a random 32-byte key is generated into the local, git-ignored `.env` (never printed, never committed). Production must set its own.

## 3. Files

New: `src/security/credentialCrypto.ts`, `src/db/schema/platformCredentials.ts`, `src/modules/platformCredentials/{repository,resolver,service}.ts`, `scripts/provision-platform-credentials.ts`, `drizzle/migrations/0010_*.sql` (+ snapshot/journal), tests (below), `docs/f29a-report.md`.
Modified: `src/config/env.ts`, `src/db/schema/index.ts`, `src/platform/{entitlements,usage,serviceAuth}.ts`, `.env.example`, `package.json` (one script), `docs/architecture.md` / `docs/manual-validation.md` (G1 note), `scripts/manual-validation-server.ts` (comment only).
Not touched: UL Platform, business modules, public API contracts.

## 4. Test strategy

- **Unit** (`tests/unit/credentialCrypto.test.ts`): round trip; non-deterministic ciphertext; tampered ciphertext/tag/IV fails; wrong organization (AAD) fails; wrong key fails; missing/malformed key fails; unsupported version fails; envelope contains no plaintext.
- **Integration** (`tests/integration/platformCredentials.test.ts`, real Postgres, stubbed introspection): persistence; retrieval; revocation; missing → fail closed; revoked → fail closed (and override cannot bypass); tenant isolation A/B; AAD swap attack (copy B's ciphertext into A's row) fails; partial unique index rejects a second ACTIVE row; idempotent re-provision; conflicting provision rejected; revoked key not resurrected; explicit rotation; concurrent resolution; concurrent provisioning race; audit rows contain no secret; errors/logs contain no secret.
- **E2E, real infrastructure** (`tests/e2e/platform-credentials-runtime.test.ts`): real Platform + real Postgres, **no in-memory registration** (registry asserted empty): provision the real organizations' credentials from the git-ignored fixture → **"restart"** (fresh module graph via a child process running `src/server.ts`) → real signed-in user calls a real entitlement-gated endpoint → 200; usage write reaches the Platform; revoke → the same request fails closed (503); secret absent from every response and from captured server output.
- Existing unit/integration/e2e suites re-run unchanged.

## 5. Migration strategy

`drizzle-kit generate` from the schema → review SQL (additive: one table, indexes, checks) → `drizzle-kit migrate` on the configured DB → verify via `na_pista_drizzle_meta` count and that pre-existing tables/row counts are unchanged. Re-running `migrate` is a no-op (drizzle journal). Rollback: forward-only per repo convention; manual rollback = `DROP TABLE na_pista.organization_platform_credentials` (no other object depends on it), documented in the report.

## 6. Risks / open decisions

- Key management: env var today; KMS later (envelope version supports rotation).
- Na Pista "revoke" does not revoke the key on the Platform (Na Pista holds no authority to); documented — OWNER must revoke it in the Console too.
- Pre-existing lint failures (18 `no-explicit-any` in e2e helpers) are unrelated to F29A.
