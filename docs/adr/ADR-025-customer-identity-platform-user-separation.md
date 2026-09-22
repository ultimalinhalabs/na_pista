# ADR-025 — Customer Identity / Platform User Separation

- **Estado:** Accepted — implemented and integration-tested
- **Data:** 2026-09-22

## Context
F18's own ADR-009 already established that `BusinessCustomer` (Na Pista) ≠ the Platform's `customers` table
(a UL-account relationship). F21 had to build the real table and make sure nothing in the implementation
quietly reintroduces the conflation.

## Decision
`na_pista.customers` has **no foreign key, no column, and no call path** referencing UL Platform identity in
any form: no `userId`, no `platformUserId`, no call to `GET /v1/users` or any Platform identity endpoint. A
Customer is created, read, updated and archived entirely through Na Pista's own tenant-scoped repository —
proven directly: `insertCustomer`/`getCustomer`/`updateCustomer` take a `TenantContext` and nothing resembling
a Platform identity, and no test fixture ever wires a Customer to a `users`/membership row. A business can
register "João Manuel, +244923456789" who has never authenticated with anything, and the schema has no
column that could even represent "this customer has a UL account" — that link, if it's ever built (F18's
ADR-009 already named this as a possible future step, e.g. `platform_user_id` nullable, explicit linking
only), is deliberately not started here to avoid inventing an identity-merging mechanism nobody asked for yet.

## Alternatives
A nullable `platformUserId` column "for later" — rejected: F18's ADR-009 already specifically warned against
linking by convenience (e.g. matching by email) and said an explicit future linking mechanism, if built, should
be its own deliberate step. Adding the column now with no linking logic behind it would be dead schema
inviting exactly the kind of implicit-matching shortcut ADR-009 rejected.

## Consequences
- (+) Zero risk of accidentally associating a business's customer record with the wrong (or a stranger's) UL
  account via email/phone coincidence.
- (+) Na Pista's Customer domain has zero runtime dependency on Platform identity beyond the human/service
  credential authenticating the *request* — the *data* is fully independent.
- (−) No customer self-service/portal is possible yet (out of scope — F21 brief §24) — a future slice that
  wants one has to design the linking step ADR-009 deferred, not inherit one from here.
