# ADR-052 — Filtering & Sorting Conventions

- **Estado:** Accepted — implemented (F30)
- **Data:** 2026-10-01
- **Phase:** F30
- **Supersedes:** the *Filtros* / *Ordenação* rows of `api-boundary.md` §2 (`?sort=name,-createdAt` was never implemented).

## Context

Filters exist and are validated by strict Zod schemas, but are undocumented as a convention; one is wrong
(`zeroStock=false` parses as `true` — `z.coerce.boolean()` treats any non-empty string as true). No list can be sorted.

## Decision

**Filtering**
- Filters stay **per endpoint, explicitly declared** in the endpoint's Zod query schema; unknown parameters remain a
  `400 VALIDATION_ERROR` (`.strict()`). No generic filter language, no operators, no JSON querying.
- Conventions (names already in use, now documented): `status` (enum), `q` (case-insensitive substring on the
  resource name), `<resource>Id` (UUID foreign-key equality), `from`/`to` (date or date-time range, inclusive,
  validated `to ≥ from`).
- `q` is kept (not renamed `search`): it is the current public name and the Console sends it. It matches a
  case-insensitive substring of the resource name (customers: name, e-mail **or** phone). `%`, `_` and `\` in `q` are
  matched **literally** — found in F30: they were passed into `ILIKE` unescaped, so `q=%` matched every row
  (parameterized, so never SQL injection, but wrong results).
- Boolean filters accept exactly `true` / `false` (`zeroStock`). Anything else → 400.
- No new filters are added to business lists in F30; the audit list (ADR-055) defines its own.

**Sorting**
- `sort=<field>&order=asc|desc`, single field. Each endpoint publishes an **allowlist** mapping public names to
  known columns in code (`Record<publicName, Column>`); a value outside it is rejected by the Zod enum before any
  query is built, so client input can never become an SQL identifier.
- The resolved ORDER BY is always `<field> <order>, id <order>` (total, deterministic).
- Defaults = today's order (`createdAt desc` for catalog lists and orders, `updatedAt desc` inventory, `createdAt desc`
  movements, `startAt asc` appointments, `createdAt desc` audit).

| Endpoint | `sort` allowlist |
| --- | --- |
| categories, products, customers, services, professionals | `createdAt`, `name` |
| orders | `createdAt`, `updatedAt` |
| inventory | `updatedAt`, `quantity` |
| inventory movements, appointments, audit events | default only (chronological by nature) |

## Alternatives considered

- Multi-field `sort=name,-createdAt` (api-boundary.md): more expressive, more surface; no consumer needs it. Rejected.
- Free column names validated against the table: still couples the public contract to column names. Rejected.
- Renaming `q` → `search` with an alias: churn without benefit. Rejected.

## Compatibility impact

Additive except `zeroStock`: `false` now means "no filter" (it meant "only zero" — a defect), and values other than
`true`/`false` (e.g. `1`) now return 400. The Console sends only `true`.

## Migration impact

None. Name sorting runs on tenant-sized tables already filtered by `(organization_id, …)` indexes; measured in F30
(report §Performance) before deciding on new indexes.

## Testing impact

Allowed field asc/desc, disallowed field → 400, injection-shaped values → 400, deterministic default, ties broken by
`id`, valid/invalid/combined filters, tenant isolation, `zeroStock=true|false|1`.
