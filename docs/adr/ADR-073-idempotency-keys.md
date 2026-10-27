# ADR-073 — Idempotency-Key on orders, customers and stock movements

- **Estado:** Accepted — implemented locally (branch `feature/idempotency-keys`; not deployed). Migration `0012_idempotency_keys`.
- **Data:** 2026-10-27
- **Origem:** readiness audit 2026-10-22, P1-2 (`projeto_ul/docs/architecture/NA-PISTA-READINESS-AUDIT-2026-10-22.md`): a retried
  `POST /orders` created a second order and a retried stock `RECEIPT` was counted twice (the balance was wrong).

## Decision

- `POST /organizations/:org/orders`, `/customers` and `/inventory/:productId/movements` accept an `Idempotency-Key` header
  (1–200 visible ASCII characters). **Required for service credentials** (400 `IDEMPOTENCY_KEY_REQUIRED`) — external interfaces are
  where retries happen; **optional for users** (the Console keeps working unchanged).
- Table `na_pista.idempotency_keys`, unique on (organization, actor type, actor id, key), written **in the same transaction** as the
  business fact:
  - first time → claim, create, bind `resource_id`, commit together;
  - same key + same request (sha256 of operation + path params + validated body, key order irrelevant) → the existing resource is
    re-read and returned, `201` + `Idempotent-Replayed: true`, **no write, no audit event, no usage event**;
  - same key + different request → 409 `IDEMPOTENCY_KEY_REUSED`;
  - concurrent requests with the same key: the second waits on the unique index, then replays;
  - a failed request rolls the claim back with everything else: the key is not used up.
- No response body is stored (no copy of personal data): a replay returns the resource's **current** state.
- Authorization order is unchanged: authentication, tenant, module, permission/scope come first; then body and key validation.

## Consequences

- Retries from interfaces, timeouts and double clicks create at most one order, one customer, one movement.
- The table grows by one small row per keyed create. Retention/purge (e.g. older than 30 days, via the existing daily cron) is a
  follow-up; nothing depends on old keys except replays of very late retries.
- Other creating endpoints (products, categories, services, professionals, appointments) are not covered yet; appointments are already
  protected against double booking by the exclusion constraint.
- Evidence: `tests/integration/idempotency.test.ts` (9), `tests/unit/idempotencyHeader.test.ts` (4), `tests/e2e/idempotency.test.ts` (8).
