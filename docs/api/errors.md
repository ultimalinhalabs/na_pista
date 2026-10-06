# Errors

Every error has the same shape and a stable `code`:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request payload",
             "details": [ { "location": "query", "path": "pageSize", "message": "Too big: expected number to be <=100" } ] } }
```

- **Branch on `code`**, then on the HTTP status. `message` is for humans and may change.
- `details` (optional) appears on `VALIDATION_ERROR` when field-level information exists: `location` (`body`,
  `query`, `path`), `path` (dotted field path in *your* input — empty for "the whole body") and `message`. Your
  submitted values are never echoed back.
- Every response — success or error — carries `X-Request-ID`.
- Unknown codes: treat by HTTP status. New codes may be added; existing ones are not renamed within `/v1`.

## Generic codes

| Status | Code | Meaning | What to do |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Malformed JSON, unknown/invalid field or query parameter, malformed id in the path | Fix the request (see `details`) |
| 401 | `UNAUTHORIZED` | Missing, malformed, expired or rejected token | Re-authenticate |
| 403 | `FORBIDDEN` | Not a member / credential not for this organization / missing permission or scope | Do not retry |
| 403 | `ENTITLEMENT_REQUIRED` | Na Pista not enabled for the organization | Subscription issue |
| 404 | `NOT_FOUND` | Resource not found **in this organization** (other organizations' ids look identical), or unknown route | — |
| 409 | `CONFLICT` | Conflicts with current state (e.g. duplicate) | Re-read, then decide |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the server limit (100 kB) | Send less |
| 503 | `UPSTREAM_UNAVAILABLE` | The UL Platform or Na Pista's database is unreachable, or the organization's Platform credential is missing/revoked | Retry later with backoff; reads are safe to retry |
| 500 | `INTERNAL_ERROR` | Unexpected | Report the `X-Request-ID` |

An unauthenticated request to an unknown `/v1` route gets `401` first — route existence is not disclosed.

## Domain codes

| Status | Code | Raised by |
| --- | --- | --- |
| 400 | `BOOKING_HORIZON_EXCEEDED` | Booking/rescheduling more than 365 days ahead |
| 404 | `PRODUCT_NOT_FOUND`, `INVENTORY_NOT_FOUND` | Inventory reads/movements, order items |
| 404 | `ORDER_NOT_FOUND` | Order routes |
| 404 | `APPOINTMENT_NOT_FOUND` | Appointment routes |
| 409 | `INSUFFICIENT_STOCK` | Stock decrease below zero (adjustment out, order confirmation) |
| 409 | `PRODUCT_ARCHIVED`, `PRODUCT_PRICE_REQUIRED`, `CUSTOMER_ARCHIVED` | Movements / orders |
| 409 | `INVALID_ORDER_STATE`, `EMPTY_ORDER` | Order lifecycle |
| 409 | `PROFESSIONAL_ARCHIVED`, `SERVICE_ARCHIVED` | Associations, availability, booking |
| 409 | `TIMEZONE_NOT_CONFIGURED` | Availability and appointments before `PUT /settings` |
| 409 | `APPOINTMENT_CONFLICT`, `APPOINTMENT_OUTSIDE_AVAILABILITY` | Booking / rescheduling |
| 409 | `INVALID_APPOINTMENT_STATE`, `APPOINTMENT_COMPLETION_TOO_EARLY`, `APPOINTMENT_NO_SHOW_TOO_EARLY` | Appointment lifecycle |

Each operation in [openapi.json](openapi.json) lists the codes it can return.

## Never in an error

Stack traces, SQL or driver messages, database or connection details, internal file paths, credentials, tokens,
ciphertext or anything about encryption. Driver details are logged server-side only, under the request id.

## Retrying

- `503`: retry with exponential backoff. Reads are always safe to retry.
- State transitions (`confirm`, `cancel`, `complete`, `no-show`) are single atomic operations: a retry of one that
  already succeeded returns `409 INVALID_…_STATE` instead of applying twice — re-read the resource.
- Creations (`POST` of a new resource) are **not** idempotent today; there is no `Idempotency-Key`. After a timeout,
  list/search before creating again.
- Rate limiting: none in Na Pista today (the Platform may rate-limit its own endpoints).
