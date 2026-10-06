# Filtering (ADR-052)

Each list endpoint accepts a small, explicit set of filters. There is no generic filter language and no operators:
a parameter the endpoint does not declare is rejected with `400 VALIDATION_ERROR` (so a typo never silently returns
everything).

## Conventions

| Parameter | Meaning |
| --- | --- |
| `status` | Exact lifecycle state (e.g. `ACTIVE` / `ARCHIVED`, `DRAFT` / `CONFIRMED` / …) |
| `q` | Case-insensitive substring. `%`, `_` and `\` are matched literally (not wildcards) |
| `<resource>Id` | Exact id of a related resource (UUID), e.g. `customerId`, `serviceId` |
| `from` / `to` | Range. Organization-local dates (`YYYY-MM-DD`, inclusive) for appointments and availability; ISO-8601 date-times (`from` inclusive, `to` exclusive) for audit events |
| booleans | Exactly `true` or `false` |

Filters combine with AND, and with pagination and sorting.

## Per endpoint

| Endpoint | Filters |
| --- | --- |
| `GET /categories` | `status` |
| `GET /products` | `status`, `categoryId`, `q` (name) |
| `GET /customers` | `status`, `q` (name, e-mail **or** phone) |
| `GET /services` | `status`, `q` (name) |
| `GET /professionals` | `status`, `q` (name), `serviceId` (professionals who provide it) |
| `GET /orders` | `status`, `customerId` |
| `GET /inventory` | `zeroStock` (`true` = only balances at exactly zero; `false` = no filter) |
| `GET /appointments` | `from`, `to` (required, ≤ 31 days), `professionalId`, `customerId`, `serviceId`, `status` |
| `GET /professionals/{id}/availability` | `from`, `to` (required), `serviceId` |
| `GET /professionals/{id}/bookable-slots` | `date`, `serviceId` (both required) |
| `GET /audit-events` | `action`, `actorType`, `resourceType`, `resourceId`, `from`, `to` |

> Changed in F30: `zeroStock=false` used to behave like `true` (any non-empty value was accepted as true). It now
> means "no filter", and values other than `true`/`false` are rejected.
