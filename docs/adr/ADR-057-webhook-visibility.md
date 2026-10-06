# ADR-057 — Webhook Visibility

- **Estado:** Accepted — implemented (F30, documentation + contract only)
- **Data:** 2026-10-01
- **Phase:** F30

## Context

(`docs/f30-audit.md` §10.) The UL Platform owns webhook endpoints, subscriptions, signing and delivery. Its API exposes,
to humans only: create (`webhook.manage`, OWNER — secret returned once), list/detail (`webhook.read`, OWNER+ADMIN —
`id, application, organizationId, status, createdAt, revokedAt, eventTypes`, no URL, no secret), revoke, test.
Delivery attempts are persisted but **no Platform API reads them**. Na Pista **publishes no events** today (ADR-050's
outbox is not implemented), so no Na Pista webhook can currently fire.

## Decision

- Na Pista exposes **no webhook endpoints of its own** in F30: no proxy, no copy of the Platform's routes, no
  parallel subscription store, no delivery history.
- `docs/api/webhooks.md` documents the real model: which Platform endpoints to call, who may call them, what metadata is
  visible, that secrets are shown once, how signatures work (as implemented by the Platform), and — explicitly — that
  Na Pista publishes no events yet and that delivery history is not readable through any API.
- The Console keeps calling the Platform directly for webhooks (already the case since F29).
- When ADR-050 is implemented, its event catalogue (types + payload schemas) becomes part of Na Pista's OpenAPI
  (`webhooks` section of OpenAPI 3.1); delivery history visibility needs a Platform read API first.

## Alternatives considered

- **Na Pista proxy of the Platform webhook API** (`/v1/organizations/:id/webhooks` on Na Pista): duplicates a contract the
  Platform already publishes, adds a second authorization path and a second place for bugs, for zero new capability.
  Rejected (CLAUDE.md principle: do not re-implement what the Platform provides).
- **Reading `webhook_deliveries` directly**: cross-asset database access — forbidden (CLAUDE.md §2). Rejected.
- **Documenting a future event catalogue as available**: fake capability. Rejected.

## Compatibility impact

None.

## Migration impact

None. Delivery visibility is a Platform change (a read endpoint over `webhook_deliveries`), recorded as deferred.

## Testing impact

No Na Pista webhook surface to test. Documentation accuracy is checked against the Platform source (routes, permissions,
metadata shape) during F30; the Na Pista route-coverage test proves no webhook route is (accidentally) exposed.
