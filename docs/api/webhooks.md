# Webhooks (ADR-057)

## Current state — read this first

- **Na Pista does not publish any events yet.** No Na Pista webhook delivery happens today. (A transactional outbox
  for appointment events is designed — ADR-050 — but not implemented.) Until it is, integrate by reading the API
  (e.g. poll lists sorted by `updatedAt`, or read the audit trail).
- **Webhooks belong to the UL Platform**, not to Na Pista. Na Pista has no webhook endpoints of its own; requests
  to e.g. `/v1/organizations/{id}/webhooks` on the Na Pista API return `404`.

## Managing endpoints (UL Platform API)

Human callers only (user tokens; integration keys cannot manage webhooks).

| Operation | Platform route | Permission |
| --- | --- | --- |
| Create | `POST {PLATFORM_URL}/v1/organizations/{id}/webhooks` — `{ "applicationKey": "NA_PISTA", "url": "https://…", "eventTypes": ["…"] }` | `webhook.manage` (OWNER) |
| List / get | `GET …/webhooks`, `GET …/webhooks/{webhookId}` | `webhook.read` (OWNER, ADMIN) |
| Revoke | `POST …/webhooks/{webhookId}/revoke` | `webhook.manage` |
| Send a test delivery | `POST …/webhooks/{webhookId}/test` (rate-limited) | `webhook.manage` |

The Na Pista Console's integration centre uses these same Platform routes.

Visible metadata: `id`, `application`, `organizationId`, `status`, `createdAt`, `revokedAt`, `eventTypes`. The
signing **secret is returned once**, in the creation response, and never again; the endpoint URL is not returned
by the read routes.

**Delivery history is not readable through any API today.** The Platform records each delivery attempt
internally, but exposes no read route for it; Na Pista cannot read it either (no cross-system database access).

## Receiving a delivery (as implemented by the Platform)

```
POST https://your-endpoint
Content-Type: application/json
x-ul-event-id: <unique event id>
x-ul-event-type: <type>
x-ul-timestamp: <unix seconds>
x-ul-signature: <hex HMAC-SHA256(secret, "<x-ul-timestamp>.<raw body>")>
```

1. Compute the HMAC over the **raw** body bytes (before JSON parsing) prefixed with the timestamp and a dot; compare
   in constant time.
2. Reject stale timestamps (the Platform's reference tolerance is 5 minutes).
3. Delivery is **at-least-once**: store `x-ul-event-id` and ignore repeats.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(secret, headers, rawBody) {
  const ts = Number(headers["x-ul-timestamp"]);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex");
  const given = String(headers["x-ul-signature"] ?? "");
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```
