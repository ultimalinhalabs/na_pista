# F19 spike — Platform ↔ Na Pista integration

**This is a spike, not the product.** Small, self-contained, and removable — deleting this directory removes
nothing the real Na Pista implementation depends on. Its only job is to prove, in runtime against the real
UL Platform, the security decisions F18 left open (OD-11, OD-12, OD-13, OD-14, OD-16). See
`../../docs/decisions.md` for what was decided and why, `../../docs/f19-report.md` for the full results.

## What's real here and what isn't

| Real | Not real / minimal on purpose |
|---|---|
| UL Platform: the actual running service, actual HTTP API, actual PostgreSQL (Supabase) | Na Pista's own "Product" resource: id/organizationId/name/status only — not the real Product module (see `../../docs/modules.md`) |
| Supabase-issued bearer tokens (minted locally with the same technique `ul-platform/scripts/smoke.ts` uses — no real Supabase login needed) | No UI |
| Real `ulk_...` API keys, created through the Platform's real `POST /organizations/:id/api-keys` | No outbox/usage/event publishing (F19 §24 excludes it) |
| Na Pista's own Postgres schema (`na_pista_spike`, same physical server as the Platform's DB in this environment only — see `../../docs/decisions.md` §OD-16) | No migrations pipeline — `scripts/db-init.ts` is raw, idempotent DDL |

## Prerequisites

1. `ul-platform` running locally (`npm run dev` in that repo) against a real, migrated, seeded Postgres.
2. This spike's `.env` filled in from `.env.example` (own Postgres connection, Platform API URL, Supabase URL).
3. `npm install` in this directory.
4. `npm run db:init` — creates this spike's own schema/table (idempotent).

## Provisioning test fixtures

Fixtures are created against the **real, running** Platform by a script that lives in `ul-platform` (it needs
`SUPABASE_JWT_SECRET`, which must never leave that process — see that script's own header comment):

```bash
# in ul-platform/
npm run f19:provision   # writes na-pista/spikes/platform-integration/.fixtures/f19-fixtures.json
# ... run this spike's tests ...
npm run f19:teardown    # removes every F19_TEST_ORG_* organization and f19-*@test.ul-platform.invalid user
```

`.fixtures/f19-fixtures.json` contains real bearer tokens and API key secrets for **synthetic, clearly-named
test accounts only** (`F19_TEST_ORG_A/B/C/D/E`, `f19-owner-*@test.ul-platform.invalid`, ...) — never real
accounts, never committed (gitignored).

## Running

```bash
npm run typecheck
npm run test:unit    # pure functions, no network, no DB
npm run test:e2e     # real Platform + real DB — needs fixtures provisioned first (see above)
npm run rls:spike     # standalone OD-16 technical spike — see ../../docs/decisions.md §OD-16
```

## Layout

```
src/
  config/env.ts          spike-only env validation
  auth/jwt.ts             local shape/expiry pre-check only — see ADR-012 for why nothing more
  platform/               everything that talks to UL Platform (client, membership, entitlements,
                          service credential registry, inbound service-credential introspection)
  tenancy/                TenantContext resolution (human membership or service credential match)
  authorization/          local role -> permission map (OD-12)
  middleware/             authenticate, requireAuthorized, requireScope, requireCapability, errorHandler
  modules/products/       the one minimal resource (F19 §24) — repository/service/routes
  db/                     Na Pista's own schema + client
tests/
  unit/                   pure functions — entitlement interpretation, limit math, repository guard
  e2e/                    real Platform + real DB; one scenario file per F19 concern
scripts/
  db-init.ts / db-teardown.ts    this spike's own DB schema
  rls-spike.ts                   standalone OD-16 technical spike (own throwaway schema + role)
```
