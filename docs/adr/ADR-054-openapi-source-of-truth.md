# ADR-054 — OpenAPI Source of Truth

- **Estado:** Accepted — implemented (F30)
- **Data:** 2026-10-01
- **Phase:** F30

## Context

ADR-005 and `api-boundary.md` promise a published OpenAPI 3 contract; none exists. Request validation already lives in
Zod 4 schemas. Response shapes exist only implicitly (Drizzle rows + service mapping).

## Decision

- **One schema system: Zod.** The OpenAPI 3.1 document is **generated** from:
  - the **existing** Zod request schemas (body, query) — the same objects the handlers use to validate;
  - **new Zod response schemas** in `src/contract/`, one per resource, which are also used by tests to validate real
    responses (so the documented shape is checked against what the server actually returns);
  - an operation registry (`src/contract/operations.ts`): method, path, summary, permission, scope, request/response
    schema references, error codes.
- Conversion uses Zod 4's built-in `z.toJSONSchema()` (JSON Schema 2020-12 = the OpenAPI 3.1 dialect) — no extra
  runtime dependency.
- Published two ways: `GET /v1/openapi.json` (unauthenticated, no secrets, no internal detail) and the committed file
  `docs/api/openapi.json`, regenerated with `npm run openapi:generate`.
- Tests: the committed file equals the generated one (drift check); every Express route is documented and every
  documented operation exists (both directions, by walking the router stack); every `$ref` resolves; the document
  validates against the official OpenAPI 3.1 schema (dev-only validator, see below); representative real responses
  validate against the response schemas.
- Permissions/scopes are documented per operation with the `x-na-pista-permission` / `x-na-pista-scope` extensions.

**Dev dependency:** `@readme/openapi-parser` (test-only) to validate the generated document against the official
OpenAPI 3.1 schema. Justification: "spec validates" is a quality gate; hand-rolled structural checks cannot prove
conformance to the specification. It is not used at runtime.

## Alternatives considered

- Hand-written YAML: a second, unvalidated description that drifts. Rejected.
- `zod-to-openapi` / `@asteasolutions/zod-to-openapi`: requires schema annotations and a new runtime dependency; Zod 4
  already emits JSON Schema natively. Rejected.
- Generating response schemas from Drizzle tables: would publish table structure (columns not in responses, internal
  names) as the contract — contradicts CLAUDE.md §9. Rejected.

## Compatibility impact

None on existing endpoints. Adds `GET /v1/openapi.json`.

## Migration impact

None. Every future endpoint must be added to the registry or the route-coverage test fails.

## Testing impact

As listed above; the route-coverage test makes an undocumented route a test failure.
