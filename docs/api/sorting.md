# Sorting (ADR-052)

```http
GET /v1/organizations/{organizationId}/products?sort=name&order=asc
```

- `sort` — one field from the endpoint's allowlist; `order` — `asc` or `desc`.
- Anything outside the allowlist is rejected (`400 VALIDATION_ERROR`, `details[0].location = "query"`). Field names
  are mapped to columns in code; your input never becomes part of a query.
- Ties are always broken by `id` in the same direction, so ordering is deterministic and pages never overlap.

| Endpoint | `sort` | Default |
| --- | --- | --- |
| categories, products, customers, services, professionals | `createdAt`, `name` | `createdAt desc` |
| orders | `createdAt`, `updatedAt` | `createdAt desc` |
| inventory | `updatedAt`, `quantity` | `updatedAt desc` |
| inventory movements | — | newest first |
| appointments | — | `startAt asc` |
| audit events | — | newest first |

Name ordering follows the database collation.
