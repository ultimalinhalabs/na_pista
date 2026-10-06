# Pagination (ADR-051)

Every list of stored records is paginated the same way:

```http
GET /v1/organizations/{organizationId}/products?page=2&pageSize=25
```

```json
{
  "data": [ { "id": "…", "name": "…" } ],
  "pagination": { "page": 2, "pageSize": 25, "total": 137, "totalPages": 6 }
}
```

| Parameter | Rule |
| --- | --- |
| `page` | integer ≥ 1, default 1, max 10 000 |
| `pageSize` | integer ≥ 1; default and maximum per endpoint (below) |
| `limit` | deprecated alias of `pageSize`, kept for older clients — never send both (`400`) |

| Endpoint | Default / max `pageSize` | Order |
| --- | --- | --- |
| categories, products, customers, services, professionals, orders | 50 / 100 | `createdAt desc` (sortable) |
| inventory (balances) | 50 / 100 | `updatedAt desc` (sortable) |
| inventory movements | 50 / 100 | newest first |
| appointments (`from`/`to` ≤ 31 days) | 200 / 500 | `startAt asc` |
| audit events | 50 / 100 | newest first |

- `total` counts every record matching your filters **in this organization**, at query time.
- A page past the end returns `data: []` with the real `total` — not an error.
- Order is always total: equal sort values are broken by `id`, so the same request returns the same rows in the same
  order.
- Without `page`/`pageSize` you get the first page with the default size — exactly the rows these endpoints returned
  before pagination existed.

## Walking every page

```js
async function* all(path, token) {
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=100`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
    yield* body.data;
    if (page >= body.pagination.totalPages) return;
  }
}
```

Records created while you page can shift later pages (offset pagination). When you need a fixed set:

- **audit events:** pin `to` to the time of your first request (new events always have a later `createdAt`);
- **other lists:** sort by `createdAt asc` so new records land on the last page, or re-check totals.

## Not paginated

Bounded sub-collections and computed views return their full result as `{ "data": [ … ] }`:
`professionals/{id}/services`, `professionals/{id}/schedule`, `professionals/{id}/schedule/exceptions`,
`professionals/{id}/availability`, `professionals/{id}/bookable-slots`, and an order's `items`.
