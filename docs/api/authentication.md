# Authentication & organization context

Every route except `GET /v1/health` and `GET /v1/openapi.json` requires:

```
Authorization: Bearer <token>
```

Na Pista never verifies a secret itself: both kinds of token are checked by the **UL Platform** on every request
(results are cached for a few seconds).

## Two kinds of caller

| | Human user | Integration (service) credential |
| --- | --- | --- |
| Token | UL Platform user access token (Supabase Auth JWT), obtained by signing in through a UL application | `ulk_…` key issued by the UL Platform for **one** organization and the `NA_PISTA` application |
| Who is it for | Your staff using your interface | Your server, a back-office job, another system |
| What it may do | What the user's **role** in the organization allows (OWNER, ADMIN, MANAGER, STAFF) | What the key's **scopes** allow: `catalog.read` (reads), `catalog.write` (mutations) |
| Where it must live | The user's browser/app session | **Server-side only.** Never ship a `ulk_` key to a browser or mobile app |

Do not use a person's session as a long-lived integration credential, and do not use an integration key to act as
a person.

### Getting an integration key

An organization **OWNER** creates it on the UL Platform (the Na Pista Console's integration centre does this for you):

```http
POST {PLATFORM_URL}/v1/organizations/{organizationId}/api-keys
Authorization: Bearer <owner user token>
Content-Type: application/json

{ "applicationKey": "NA_PISTA", "scopes": ["catalog.read", "catalog.write"] }
```

The secret is returned **once**, in that response. Store it in your server's secret store. Revoke it on the Platform
(`POST …/api-keys/{keyId}/revoke`) when no longer needed or if it may have leaked.

## Organization context

Business routes live under `/v1/organizations/{organizationId}/…`. The id in the path is **never trusted on its
own**:

- a human must be an **active member** of that organization (checked with the Platform on each request);
- a service credential must have been issued **for that organization**.

Otherwise the answer is `403 FORBIDDEN` — the same whether the organization does not exist or you simply do not
belong to it.

The organization must also have Na Pista enabled (an active Na Pista subscription → the `catalog.enabled`
entitlement). Otherwise: `403 ENTITLEMENT_REQUIRED` (or `503 UPSTREAM_UNAVAILABLE` if Na Pista cannot reach the
Platform on the organization's behalf — see [credentials.md](credentials.md)).

## Permissions by role

| Role | Can |
| --- | --- |
| OWNER, ADMIN | Everything, including archiving catalogue items/customers, reading the audit trail and integration status |
| MANAGER | Everything operational; cannot archive products/categories/customers; no audit/integration reads |
| STAFF | Read-only |

Each operation in the OpenAPI document states its permission (`x-na-pista-permission`), its service scope
(`x-na-pista-scope`; absent = humans only) and whether it needs the capability (`x-na-pista-capability`).

## Request references

Send `X-Request-ID: <your id>` (letters, digits, `.`, `_`, `-`; up to 128) to correlate a call with your logs; Na Pista
echoes it, or generates one, on **every** response. Quote it when reporting a problem.
