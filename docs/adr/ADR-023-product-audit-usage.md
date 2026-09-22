# ADR-023 — Product Audit / Usage

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F18's `audit.md`/`usage.md` sketched the design (Na Pista's own audit trail, separate from the Platform's;
usage as observability reusing an existing Platform meter). F20 had to build both for real and prove neither
one is faked.

## Decision — Audit
Na Pista's own `audit_events` table (`na_pista` schema), written in the **same transaction** as the resource
mutation (`db.transaction(...)` wrapping both the `INSERT`/`UPDATE` on `products`/`categories` and the audit
row) — if the audit write fails, the whole transaction rolls back, so a resource can never exist without its
creation being audited (a stronger guarantee than the Platform's own `recordAuditEvent`, which deliberately
swallows failures — F20 brief §19/§29 explicitly requires "audit failure: behavior explicitly defined", and
this is that definition). Events: `product.created`, `product.updated`, `product.deleted`, `category.created`,
`category.updated`, `category.deleted` — `deleted` used specifically for the archive operation (ADR-020),
kept distinct from `updated` so an audit reader can tell "this was an explicit removal" from "a field changed"
without inspecting the metadata. Minimum fields present on every row: `organizationId`, `actorType`/`actorId`
(never trusted from client input — derived server-side from the authenticated identity), `action`,
`resourceType`/`resourceId`, `requestId`, `createdAt`. No secrets, no full request bodies logged — `metadata`
carries only what changed (e.g. `changedFields`), never raw payloads.

**Proven live** (`tests/e2e/audit-and-usage.test.ts`): a real product creation produces exactly one matching
row with the correct actor/action/requestId; archiving a category produces `category.deleted`, distinct from
`category.updated`.

## Decision — Usage
Every product/category write also records one `api_requests` usage event on the Platform (the org's own
"platform-facing" service credential, `usage.write` scope — OD-11), fire-and-forget: a usage-write failure is
logged but **never** rolls back or blocks the response (ADR-017's "telemetry may degrade gracefully" applies
here specifically, unlike audit above). **No `products`/`categories` meter exists in the Platform's seed** (F19's
`platform-changes-required.md` §PC-5) — rather than invent one the Platform would reject, or fake a local-only
counter, this records against `api_requests`, the one meter that is both real and honest about what it
measures ("a write request happened"), and is proven live to actually increase on the real Platform.

## Alternatives
Making the usage write synchronous and part of the same transaction as audit — rejected: usage is explicitly
a different category of fact (ADR-017), and coupling it to the transaction would mean a slow/unavailable
Platform could fail or slow down every product write, which F19's own posture on usage explicitly rejects.
A dedicated local `usage_events` mirror table in Na Pista's own database — rejected as unnecessary duplication;
the Platform is already the system of record for usage (F18 CLAUDE.md boundary).

## Consequences
- (+) Audit is provably atomic with the mutation it describes; usage is provably real (Platform-verified, not
  a local mock).
- (+) Two different failure postures for two different categories of side effect, each matching its own
  criticality — not one generic "best effort" applied uniformly.
- (−) A `products`/`appointments`-specific meter remains a documented, deferred Platform seed change
  (PC-5) — `api_requests` is an honest proxy, not the eventual real metric.
