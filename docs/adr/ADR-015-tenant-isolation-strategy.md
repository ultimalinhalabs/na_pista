# ADR-015 — Tenant Isolation Strategy

- **Estado:** Accepted
- **Data:** 2026-09-22
- **Closes:** OD-16

## Context
F18's ADR-002 established `organization_id` + a TenantContext-requiring repository as the enforced isolation
mechanism, with RLS deferred to a technical spike ("do not activate RLS blindly"). F19 ran that spike against
the real connection this environment provides.

## Decision
**RLS is not enabled.** App-level enforcement (`organization_id NOT NULL`, a repository that cannot run
without a `TenantContext` — `src/modules/products/repository.ts`'s `assertTenant`) remains the only enforced
mechanism. This is a real technical conclusion from a real spike, not a default left unexamined: the only
Postgres role this environment's connection string can authenticate as has `BYPASSRLS = true` (confirmed via
`pg_roles`), which makes RLS policies — with or without `FORCE ROW LEVEL SECURITY` — a complete no-op for this
connection, measured directly (`scripts/rls-spike.ts`).

The spike also proved RLS **would** work correctly with a dedicated, least-privilege, non-`BYPASSRLS` role
(created, used, and dropped within the same run) — isolation held for two sequential tenant reads through
that role. Getting that role to connect through Supabase's Supavisor pooler required its username to be
`<role>.<project-ref>`, not a bare role name (`ENOIDENTIFIER` otherwise) — an operational detail worth
recording for whoever provisions that role for real.

## Alternatives
- **Enable RLS anyway** ("it doesn't hurt") — rejected: with the current connection it is a placebo, and F19
  §17 explicitly says not to activate it without evidence it would work — a misconfigured-looking `ENABLE ROW
  LEVEL SECURITY` in a migration could give a false sense of a second protection layer that isn't there.
- **Schema-per-tenant / database-per-tenant** — not evaluated in this spike (out of scope: F18 already chose
  a shared-schema model with `organization_id`, CLAUDE.md §14 "do not solve future scale problems with
  unnecessary complexity today"); nothing in this spike's findings argues for revisiting that.

## Consequences
- (+) The primary, already-enforced mechanism (repository requiring `TenantContext`) is unaffected by this
  decision either way — isolation does not regress by leaving RLS off.
- (+) A concrete, evidence-backed precondition exists for turning RLS on later: provision the dedicated role,
  repeat the concurrency stress test against it specifically (only run against the bypassing role in this
  pass), then `ENABLE` + `FORCE ROW LEVEL SECURITY`.
- (−) No second, independent layer against an application-level bug that skips the repository's tenant guard
  — the repository's own structural guard (`assertTenant`, unit-tested) is what stands in for that today.

See `docs/decisions.md` §OD-16 for the full runtime evidence.
