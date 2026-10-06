# ADR-051 — Collection Pagination & List Envelope

- **Estado:** Accepted — implemented (F30)
- **Data:** 2026-10-01
- **Phase:** F30
- **Supersedes:** the pagination clause of ADR-005 ("paginação por cursor") and the *Paginação* row of
  `api-boundary.md` §2 — both described a cursor contract that was never implemented.

## Context

Every list endpoint truncates silently at `limit` (default 50, max 100; appointments 200/500) and returns
`{ "data": [...] }` with no metadata (`docs/f30-audit.md` §6–7). A client cannot know that rows are missing or fetch
them. Eight of nine lists order by a non-unique timestamp only, so even the first page is not deterministic on ties.
The Console shows a "first 100" notice and computes dashboard counts from list length, which is wrong past 100.

## Decision

**Page-based pagination (SQL `LIMIT`/`OFFSET`) with totals, on every list of stored rows:**

| Query | Rule |
| --- | --- |
| `page` | integer ≥ 1, default 1, max 10 000 |
| `pageSize` | integer ≥ 1; default and maximum **per endpoint, unchanged from today** (50/100; appointments 200/500; audit 50/100) |
| `limit` | **deprecated alias of `pageSize`**, still accepted; sending both → `400 VALIDATION_ERROR` |

Response — additive, `data` keeps its exact current shape:

```json
{ "data": [ … ], "pagination": { "page": 1, "pageSize": 50, "total": 137, "totalPages": 3 } }
```

- A `page` past the end returns `data: []` with the true `total`/`totalPages` (not an error).
- Ordering is always total: each endpoint's existing primary order **plus `id` as the final tiebreaker**.
- `total` comes from a `count(*)` with the **same tenant-scoped WHERE** as the page query (one shared builder, never
  two hand-written conditions). Both run at the database; nothing is paginated in memory.
- Applies to: categories, products, customers, services, professionals, orders, inventory, inventory movements,
  appointments, audit events (ADR-055).
- **Not paginated** (documented as bounded sub-collections / computed views): `professionals/:id/services`,
  `professionals/:id/schedule`, `professionals/:id/schedule/exceptions`, `availability`, `bookable-slots`, order
  items (embedded, ≤ 100 per order).

## Alternatives considered

1. **Cursor/keyset (ADR-005, UL Platform audit log).** Stable under concurrent inserts and cheap at depth, but no
   totals and no random page access — and the Console's screens need both. Tenant tables here are small; the depth
   problem does not exist yet. Rejected for now; the one place where insert-ahead instability matters (append-only
   audit) is handled by pinning `to` (ADR-055), not by a second pagination model.
2. **`Link`/`X-Total-Count` headers.** Invisible to clients that only read the JSON body (including the Console's
   `callNaPista`). Rejected.
3. **Replace `limit` with `pageSize`.** Breaks the Console and any existing integrator. Rejected; kept as alias.
4. **Paginate the bounded sub-collections too.** Would turn "full list" into "first page" for a client that does not
   read `pagination` — a silent behaviour change. Rejected.

## Compatibility impact

Additive. A request without `page`/`pageSize` returns the **same rows** (same default size, same primary order) plus a
`pagination` key. The `id` tiebreak only fixes the order of rows that previously had equal timestamps.

## Migration impact

No schema change: `(organization_id, created_at)` / `(…, updated_at)` / `(…, start_at)` indexes already exist; `id` is the
primary key. Clients may adopt `pageSize` at will; `limit` remains until a future `/v2`.

## Testing impact

Per endpoint family: first/second page, page size, max page size (400 above), invalid page (0, negative, non-integer,
> 10 000 → 400), `limit`+`pageSize` → 400, page beyond end, deterministic order across equal timestamps, tenant
isolation of rows **and** of `total`. Real PostgreSQL.
