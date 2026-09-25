# ADR-050 — Transactional Outbox for Appointment Events (notification foundation)

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F28A (spike) — implementation slice F28D

## Context

**Current state (verified in code):** Na Pista publishes **no** events. F27 writes business audit rows
(`appointment.created/rescheduled/updated/canceled/completed`) in the mutation transaction and records usage after
commit. `docs/events.md` (F18) *proposed* an `OutboxMessage` — it was never implemented (divergence recorded in
`docs/f28a-report.md` §3).

**UL Platform transport (verified in `ul-platform/src/routes/v1/events.ts`, `modules/webhooks/*`):**
`POST /v1/organizations/:orgId/events { type, data }`, service credential with `event.publish` whose organization must
match the path; `type` must match `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` (exactly `domain.action`); the Platform builds
the envelope with a **new `evt_<uuid>` and `occurredAt` on every publish call**, then delivers synchronously, **one
attempt, no retry, no dedupe**, to the organization's ACTIVE webhook endpoints subscribed to that type (HMAC-signed).

**Problem:** customers need to be notified (WhatsApp via Qualé a Dica?!, e-mail, a tenant's own system) when bookings
change — without Na Pista calling providers, without a dual write (DB commit + HTTP call that can diverge), and without
putting the user's request on the delivery path.

## Decision

### Table

```
outbox_events {
  id               uuid PK                  -- the STABLE event id, sent as data.eventId
  organization_id  uuid NOT NULL
  aggregate_type   text NOT NULL CHECK (aggregate_type IN ('appointment'))
  aggregate_id     uuid NOT NULL
  event_type       text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$')
  event_version    integer NOT NULL CHECK (event_version >= 1)
  payload          jsonb NOT NULL
  occurred_at      timestamptz NOT NULL     -- business time of the committed transition
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','DEAD'))
  attempts         integer NOT NULL DEFAULT 0
  next_attempt_at  timestamptz NOT NULL DEFAULT now()
  last_error       text NULL                -- sanitized, ≤ 500 chars, never a credential
  delivered_at     timestamptz NULL
  created_at       timestamptz NOT NULL DEFAULT now()
  INDEX (next_attempt_at) WHERE status = 'PENDING'
  INDEX (organization_id, aggregate_type, aggregate_id, occurred_at)
}
```

`payload jsonb` is the one justified document column: it *is* a serialized outbound message whose schema is versioned by
`event_version` and never queried relationally — not a substitute for relational modelling. `aggregate_type` is a
closed list (only `appointment` in F28D; adding `order` etc. is a CHECK change), not a generic polymorphic table.

### Write side (transaction boundary)

`enqueueEvent(entry, tx)` is called **inside the same transaction** as the state change and its audit row — next to
`recordAuditEvent`. Commit ⇒ state + audit + event exist; rollback ⇒ none exist. No HTTP in the business transaction;
the user's request never waits for delivery.

### Event catalog (appointments, `event_version = 1`)

| Event | When | Payload (`data`) beyond the common fields |
|---|---|---|
| `appointment.created` | create commits | `startAt, endAt, customerId, professionalIds, serviceIds` |
| `appointment.rescheduled` | reschedule commits | `startAt, endAt, professionalIds, previous: { startAt, endAt, professionalIds }` |
| `appointment.canceled` | cancel commits | `hasReason` |
| `appointment.completed` | complete commits | — |
| `appointment.no_show` | no-show commits (ADR-048) | — |

Common fields: `eventId` (= outbox id), `eventVersion`, `occurredAt`, `appointmentId`, `status`, `actor {type, id}`.
Before ADR-045/047 are implemented, `serviceIds`/`professionalIds` are single-element arrays — the payload shape does
not change when multi-service/multi-professional land (no version bump needed).
**Not published:** `appointment.updated` (notes-only edits: internal staff notes, possible PII, no consumer).
**Deferred:** `appointment.confirmed` (no CONFIRMED state exists).
**Minimal data (events.md rule 4):** identifiers and state only — never customer name, phone, e-mail, notes or
cancellation reason text. Consumers fetch details through the Na Pista API with their own credential and scopes.

### Dispatcher

- In-process, started only by `server.ts` (never implicitly in tests), tick every 2 s.
- **Claim with a lease, not a held transaction:** `UPDATE outbox_events SET next_attempt_at = now() + interval '60 s'
  WHERE id IN (SELECT id … WHERE status = 'PENDING' AND next_attempt_at <= now() AND <ordering rule> ORDER BY
  occurred_at LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING …` — commit, then publish over HTTP outside any transaction,
  then record the outcome. A crash mid-delivery leaves the lease to expire → redelivered (at-least-once). `SKIP LOCKED`
  makes several instances safe.
- **Delivery:** `POST {PLATFORM}/organizations/:orgId/events { type: event_type, data: payload }` with the
  organization's platform-facing credential (`event.publish`) — the existing `platform/client.ts` and
  `serviceAuth.ts`.
- **Outcome:** 2xx → `DELIVERED`, `delivered_at`. Network error / timeout / 5xx / no credential registered → retry with
  backoff `min(5 s × 2^attempts, 15 min)`. Non-retryable 4xx (400 invalid type, 403 missing scope) → `DEAD`
  immediately. After 12 attempts → `DEAD`. `last_error` sanitized.
- **Ordering:** per aggregate FIFO — an event is claimable only if no *PENDING* event of the same aggregate has an
  earlier `occurred_at`. A `DEAD` event does not block later ones (otherwise one poisoned message stops an
  appointment's stream forever); consumers therefore must not assume gap-free streams — they re-fetch current state
  when in doubt.
- **Housekeeping (same loop, every 10 min):** delete `DELIVERED` older than 7 days, `DEAD` older than 30 days, and
  expired idempotency keys (ADR-049).

### Consumer contract (documented in `docs/events.md` when implemented)

At-least-once; **deduplicate by `data.eventId`** — NOT by the Platform's `X-UL-Event-Id`/envelope `id`, which is new on
every publish attempt (verified in Platform code). Order is per-appointment best effort; use `occurredAt` and re-fetch.

### Notifications boundary

Na Pista's responsibility ends at a successful Platform publish. Notification channels (e-mail, WhatsApp through
Qualé a Dica?!, any provider) are **subscribers** — webhook endpoints registered by the organization on the Platform.
Na Pista has no provider SDK, no templates, no message sending. This keeps products decoupled (CLAUDE.md §2: explicit
API/contract integration only).

### Impacts

- **Migration:** one new table (additive). Rollback: stop the dispatcher, drop the table.
- **API:** none (no new endpoint). **UI:** none in F28D (an operator view of DEAD events is deferred).
- **Tenant isolation:** every row carries `organization_id`; the dispatcher publishes with **that** organization's
  credential to **that** organization's path — the Platform additionally rejects a credential/path mismatch.
- **Authorization:** unchanged (events are side effects of already-authorized mutations).
- **Audit:** unchanged — audit (internal record) and outbox (external contract) are written side by side, neither
  derived from the other.
- **Usage:** unchanged in F28D (direct post-commit call, F27 contract). Moving usage onto the outbox (which would stop
  losing usage if the process dies between commit and the usage call) is a recorded, deferred option.
- **UL Platform:** no change. Known Platform-side limits (single webhook attempt, no dedupe) are outside Na Pista and
  recorded as external risks, not blockers.
- **Testing:** integration — event row in the same transaction (forced rollback ⇒ no row), payload has no PII fields,
  one event per committed transition, none for notes-only edits or failed writes; dispatcher with an injected Platform
  client — FIFO per aggregate, backoff schedule, 4xx → DEAD, lease expiry → redelivery, two dispatchers concurrently
  (`SKIP LOCKED`) never claim the same row; E2E — a test org registers a webhook endpoint on the real Platform pointing
  to a local receiver, books an appointment, receives `appointment.created` with the expected `data.eventId`.

## Alternatives

- **Publish synchronously after commit** — rejected: lost events on crash/network failure; the user waits.
- **Publish inside the transaction** — rejected: HTTP inside a DB transaction, and a published event for a
  transaction that may still roll back.
- **Derive events from audit rows** — rejected: audit is an internal, append-only record with a different audience and
  content (it has `appointment.updated`, includes internal metadata); coupling them would constrain both.
- **External broker (Kafka/SQS)** — rejected: new infrastructure with no demonstrated need; the Platform already is the
  transport.
- **Na Pista calls WhatsApp/e-mail providers directly** — rejected: product coupling and credential sprawl.

## Consequences

- (+) No dual write; events exist iff the business change committed; delivery retried independently of requests.
- (+) Any number of notification consumers without Na Pista changes.
- (−) At-least-once and best-effort ordering push dedupe/re-fetch duties to consumers (documented contract).
- (−) A background loop in the API process (acceptable for the current single-service deployment; extractable later).
