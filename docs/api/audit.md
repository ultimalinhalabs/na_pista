# Audit trail (ADR-055)

```http
GET /v1/organizations/{organizationId}/audit-events?resourceType=order&pageSize=50
Authorization: Bearer <OWNER or ADMIN user token>
```

```json
{
  "data": [
    {
      "id": "…",
      "action": "order.confirmed",
      "actorType": "user",
      "actorId": "…",
      "resourceType": "order",
      "resourceId": "…",
      "requestId": "…",
      "metadata": { "itemCount": 2 },
      "createdAt": "2026-10-01T09:12:44.120Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 50, "total": 1, "totalPages": 1 }
}
```

- **Who:** human OWNER or ADMIN (`audit.read`). MANAGER, STAFF and integration keys get `403`.
- **What:** Na Pista's business audit trail — the events Na Pista writes in the same transaction as each relevant
  change (e.g. `product.created`, `product.deleted` (= archived), `inventory.receipt`, `order.confirmed`,
  `appointment.canceled`, `platform_credential.provisioned`). It is append-only; nothing edits or deletes events.
- **Order:** newest first (`createdAt desc`, then `id`). Paginated ([pagination.md](pagination.md)); no `sort`.
- **Filters:** `action`, `actorType` (`user`|`service`), `resourceType`, `resourceId`, `from` (inclusive), `to`
  (exclusive) — ISO-8601 date-times.
- **Stable paging:** new events are always newer, so pinning `to` to the time of your first request gives a fixed
  set that offset pages cannot shift.
- **Metadata** is operation-specific context written by Na Pista. It never contains secrets; as a safeguard, any key
  that looks like one (`…secret…`, `…token…`, `password`, `…credential…`, `authorization`, …) is returned as
  `"[REDACTED]"`.

Platform-side events (memberships, subscriptions, API keys, …) are recorded by the UL Platform, not here; the Platform
does not currently expose an organization-level audit read API.
