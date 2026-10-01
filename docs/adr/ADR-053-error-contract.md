# ADR-053 — Public Error Contract Hardening

- **Estado:** Accepted — implemented (F30)
- **Data:** 2026-10-01
- **Phase:** F30

## Context

The envelope `{ "error": { "code", "message" } }` is consistent, but measured against the running app
(`docs/f30-audit.md` §5): malformed JSON returns `500 INTERNAL_ERROR` without `X-Request-ID`; unmatched routes return
Express's HTML page; validation errors say only "Invalid request payload", so an external developer cannot tell which
field or parameter was wrong.

## Decision

1. `requestId` runs **before** body parsing — every response, including parse failures, carries `X-Request-ID`.
2. Malformed JSON / unsupported body → `400 VALIDATION_ERROR` ("Malformed JSON body"); oversize body → `413 PAYLOAD_TOO_LARGE`.
3. Any unmatched route → JSON `404 NOT_FOUND` ("Route not found"), after authentication for `/v1` paths (an
   unauthenticated caller still gets `401` first — route existence is not disclosed to anonymous callers).
4. Validation errors gain an **additive** `details` array:
   `{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [ { "location": "query", "path": "pageSize", "message": "…" } ] } }`
   - `location` ∈ `body | query | path`; `path` is the dotted field path **of the client's own input**; `message` is
     the validator's message. Never values, never schema internals beyond the field name.
5. Codes are stable identifiers; messages are human-readable and may change. Clients branch on `code`, then HTTP status.
6. Unchanged posture: no SQL, stack, driver code, connection detail, path, credential or crypto detail ever reaches a
   response (driver codes are logged server-side only).

## Alternatives considered

- RFC 9457 `application/problem+json`: a different envelope — a breaking change for every client. Rejected.
- Exposing Zod issues verbatim: leaks schema structure (`invalid_union` trees, expected types). Rejected in favour of a
  flat, curated `details`.

## Compatibility impact

Additive (`details`). Status changes only for requests that were already failing (500 → 400, HTML 404 → JSON 404). The
`message` for Zod failures changes from "Invalid request payload" to "Invalid request" — messages are documented as
non-contractual.

## Migration impact

None.

## Testing impact

Malformed JSON → 400 + `X-Request-ID`; unknown route (anonymous → 401, authenticated → JSON 404, outside `/v1` → JSON
404); `details` present with `location`/`path` for body, query and path errors; no secret/SQL/stack in any error.
