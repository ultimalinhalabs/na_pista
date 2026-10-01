# Na Pista API — developer documentation

The API **is** the product contract. The Na Pista Console is one consumer of it; your own interface (site, app,
point of sale) uses exactly the same endpoints, with no private shortcuts.

| Start here | |
| --- | --- |
| [quickstart.md](quickstart.md) | First request to a working custom integration, with two complete examples |
| [openapi.json](openapi.json) | OpenAPI 3.1 contract — generated from the same schemas the API validates with; also served at `GET /v1/openapi.json` |

| Cross-cutting | |
| --- | --- |
| [authentication.md](authentication.md) | User tokens vs. integration (service) credentials, organization context |
| [errors.md](errors.md) | Error envelope, stable codes, `details`, what is never exposed |
| [pagination.md](pagination.md) | `page` / `pageSize`, the `pagination` object, stable traversal |
| [filtering.md](filtering.md) | Filter conventions (`status`, `q`, `…Id`, `from`/`to`) |
| [sorting.md](sorting.md) | `sort` / `order` allowlists |
| [webhooks.md](webhooks.md) | Who owns webhooks (UL Platform) and what exists today |
| [audit.md](audit.md) | Reading the organization's audit trail |
| [credentials.md](credentials.md) | Platform credential status |

| Modules | |
| --- | --- |
| [categories-api.md](categories-api.md) · [products-api.md](products-api.md) | Catalogue |
| [customers-api.md](customers-api.md) | Customers |
| [inventory-api.md](inventory-api.md) | Stock balances and movements |
| [orders-api.md](orders-api.md) | Orders and their lifecycle |
| [services-api.md](services-api.md) · [professionals-api.md](professionals-api.md) | What is provided, and by whom |
| [scheduling-api.md](scheduling-api.md) | Timezone, weekly schedules, exceptions, availability |
| [appointments-api.md](appointments-api.md) | Bookable slots and appointments |

All paths are under `/v1`. Field-level shapes live in the OpenAPI document; module docs explain behaviour and rules.
