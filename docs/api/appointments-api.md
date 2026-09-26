# Appointments & Booking API (F27)

ADR-042/043/044. Same conventions as every other Na Pista module: `/v1` prefix, tenant-scoped under
`/organizations/:organizationId`, `requireTenantContext` + `requireCapability(catalog.enabled)` +
`requireAuthorized(permission, scope)`, `{ data }` / `{ error: { code, message } }` envelope, `.strict()` bodies,
no raw Postgres errors ever returned.

| Permission | OWNER | ADMIN | MANAGER | STAFF | Service-credential scope |
|---|---|---|---|---|---|
| `appointments.read` | ✅ | ✅ | ✅ | ✅ | `catalog.read` |
| `appointments.create` | ✅ | ✅ | ✅ | ❌ | `catalog.write` |
| `appointments.update` (reschedule, notes, cancel, complete, no-show) | ✅ | ✅ | ✅ | ❌ | `catalog.write` |

There is no `appointments.delete` and no `DELETE` route — appointments are never deleted.

## Representation

```json
{
  "data": {
    "id": "…",
    "organizationId": "…",
    "customerId": "…",
    "professionalId": "…",
    "serviceId": "…",
    "startAt": "2026-10-05T08:00:00.000Z",
    "endAt": "2026-10-05T09:00:00.000Z",
    "durationMinutes": 60,
    "status": "SCHEDULED",
    "serviceName": "Personal Training",
    "servicePrice": "10000.00",
    "currency": "AOA",
    "notes": null,
    "cancellationReason": null,
    "canceledAt": null,
    "completedAt": null,
    "noShowAt": null,
    "createdAt": "…",
    "updatedAt": "…"
  }
}
```

- `startAt`/`endAt`: absolute instants (UTC `Z` on output). Display them in the **organization's** timezone
  (`GET …/settings`), never the browser's. The interval is half-open `[startAt, endAt)`.
- `durationMinutes` is derived (`endAt − startAt`), frozen at booking from the Service's duration at that
  moment; later Service edits never change it.
- `serviceName`, `servicePrice` (decimal string, or `null` if the Service was unpriced), `currency`: booking-time
  snapshots. `serviceId` stays a reference.
- `status`: `SCHEDULED` | `COMPLETED` | `CANCELED` | `NO_SHOW`. Lifecycle: `SCHEDULED` → `COMPLETED` | `CANCELED` |
  `NO_SHOW` — all three terminal (no undo, no transition out). Only `CANCELED` releases the time slot; `COMPLETED` and
  `NO_SHOW` keep occupying it. Clients that switch on `status` must handle `NO_SHOW` (added in F28B, ADR-048).
- `canceledAt` / `completedAt` / `noShowAt`: set exactly when `status` is `CANCELED` / `COMPLETED` / `NO_SHOW`
  (database CHECKs), otherwise `null`.

## `POST /v1/organizations/:organizationId/appointments`

Permission `appointments.create`. Body (`.strict()` — `endAt`, `status`, snapshots, `organizationId` are rejected):

```json
{ "customerId": "…", "professionalId": "…", "serviceId": "…", "startAt": "2026-10-05T09:00:00+01:00", "notes": "optional, ≤ 2000 chars" }
```

`startAt` must carry `Z` or an explicit offset and be a whole minute. Server-side, in order:
booking window (`now ≤ startAt ≤ now + 365 days`, absolute and inclusive) → organization timezone (fail closed)
→ one transaction: Customer ACTIVE, Professional ACTIVE, Service ACTIVE, `professional_services` association,
F26 availability (the start must be one of F26's `serviceStartTimes` for its local date, for the Service's
duration), `INSERT` (the PostgreSQL exclusion constraint is the final conflict authority), audit
`appointment.created` → commit → usage (`api_requests`). `201` with the appointment, created directly as
`SCHEDULED`.

## `GET /v1/organizations/:organizationId/appointments`

Permission `appointments.read`. Query (`.strict()`):

| Param | Required | Notes |
|---|---|---|
| `from`, `to` | yes | organization-local dates `YYYY-MM-DD`, inclusive, `to ≥ from`, **at most 31 days** |
| `professionalId`, `customerId`, `serviceId` | no | UUIDs; foreign/unknown ids simply match nothing |
| `status` | no | `SCHEDULED` \| `COMPLETED` \| `CANCELED` \| `NO_SHOW` (default: all) |
| `limit` | no | default 200, max 500 |

Returns appointments **overlapping** `[local midnight of from, local midnight of to + 1)`, ordered by
`startAt`, then `id`. Requires a configured timezone. No unbounded listing is possible.

## `GET /v1/organizations/:organizationId/appointments/:appointmentId`

Permission `appointments.read`. `404 APPOINTMENT_NOT_FOUND` for unknown or other-tenant ids.

## `PATCH /v1/organizations/:organizationId/appointments/:appointmentId`

Permission `appointments.update`. Only from `SCHEDULED`. Body (`.strict()`, at least one field):

```json
{ "startAt": "2026-10-06T14:00:00Z", "professionalId": "…", "notes": "…or null to clear" }
```

- `startAt` and/or `professionalId` = **reschedule** of the same appointment: the preserved duration, the same
  Customer/Service/snapshots; full re-validation (window, timezone, ACTIVE Customer/target Professional/Service,
  association of the target Professional with the booked Service, F26 availability) and the same exclusion
  constraint as creation. Audit `appointment.rescheduled` (`from`/`to` in metadata), usage recorded.
- `notes` alone = edit; audit `appointment.updated` (never the note text itself); no usage.
- `status`, `customerId`, `serviceId`, `endAt` are **not** accepted (`400`) — lifecycle changes use the dedicated
  endpoints below; a different customer or service is a new booking.
- A PATCH that changes nothing returns the current appointment with no audit.

## `POST …/appointments/:appointmentId/cancel`

Permission `appointments.update`. Body `{ "reason"?: string (1–500) }`. `SCHEDULED → CANCELED`, sets
`canceledAt`, releases the interval immediately. Irreversible — to book the same time again, create a new
appointment. Allowed even if the Customer/Professional/Service has since been archived.

## `POST …/appointments/:appointmentId/complete`

Permission `appointments.update`. No body. `SCHEDULED → COMPLETED` only once the **server** clock has reached
`startAt` (the end need not have passed); otherwise `409 APPOINTMENT_COMPLETION_TOO_EARLY`. A completed
appointment keeps occupying its interval.

## `POST …/appointments/:appointmentId/no-show` (F28B, ADR-048)

Permission `appointments.update` (OWNER/ADMIN/MANAGER; STAFF → `403`); service credentials need `catalog.write`;
gated by `catalog.enabled`. **No body**: an absent body or `{}` only — any field → `400 VALIDATION_ERROR`.

`SCHEDULED → NO_SHOW` only, and only once the **server** clock has reached `startAt` (otherwise
`409 APPOINTMENT_NO_SHOW_TOO_EARLY`). No upper deadline — a no-show may be recorded any time later. Sets `noShowAt`
(server time). Terminal: any later cancel/complete/no-show/reschedule/notes edit → `409 INVALID_APPOINTMENT_STATE`; from
`COMPLETED`/`CANCELED` → `409 INVALID_APPOINTMENT_STATE`. The appointment **keeps occupying** its interval (the
exclusion constraint's predicate `status <> 'CANCELED'` is unchanged), so a new booking over it gets
`409 APPOINTMENT_CONFLICT`. Audit `appointment.no_show` in the same transaction; usage (`api_requests`) after commit.
`200` with the appointment:

```json
{ "data": { "id": "…", "status": "NO_SHOW", "noShowAt": "2026-10-05T08:20:00.000Z", "canceledAt": null, "completedAt": null, "…": "…" } }
```

## `GET /v1/organizations/:organizationId/professionals/:professionalId/bookable-slots`

Permission `appointments.read`. Query: `date=YYYY-MM-DD` (organization-local) and `serviceId` — both required.

```json
{ "data": { "timezone": "Africa/Luanda", "date": "2026-10-05", "serviceId": "…", "durationMinutes": 60,
  "slots": [{ "localStartTime": "09:00", "startAt": "2026-10-05T08:00:00.000Z", "endAt": "2026-10-05T09:00:00.000Z" }] } }
```

F26's `serviceStartTimes` for that date (same 15-minute grid, same duration fit), converted to instants (a start
inside a DST gap is skipped; an ambiguous one resolves to its first occurrence), **minus** slots overlapping a
non-canceled appointment of that Professional, minus slots outside the booking window. **Advisory**: a returned
slot can still be lost to a concurrent booking — only the `POST`/`PATCH` is authoritative. Same preconditions as
F26 availability: `409 TIMEZONE_NOT_CONFIGURED`, `409 PROFESSIONAL_ARCHIVED`, `409 SERVICE_ARCHIVED`, `404`
for unknown/not-associated. Not audited, not metered.

## Errors

| HTTP | code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | malformed body/query, bare local `startAt`, non-whole-minute, `startAt` in the past, range > 31 days, forbidden fields |
| 400 | `BOOKING_HORIZON_EXCEEDED` | `startAt` more than 365 days ahead (create or reschedule) |
| 401 | `UNAUTHORIZED` | no/invalid credentials |
| 403 | `FORBIDDEN` | missing permission/scope, or no membership in the path organization |
| 403 | `ENTITLEMENT_REQUIRED` | `catalog.enabled` not granted |
| 404 | `APPOINTMENT_NOT_FOUND` | unknown or other-tenant appointment |
| 404 | `NOT_FOUND` | unknown Customer/Professional/Service, or Professional not associated with the Service (existing F26 convention) |
| 409 | `APPOINTMENT_CONFLICT` | the database exclusion constraint rejected an overlapping non-canceled appointment (create or reschedule) |
| 409 | `APPOINTMENT_OUTSIDE_AVAILABILITY` | start is not a valid F26 service start time for that local date (no override exists — add a Scheduling exception instead) |
| 409 | `TIMEZONE_NOT_CONFIGURED` | organization has no timezone |
| 409 | `CUSTOMER_ARCHIVED` / `PROFESSIONAL_ARCHIVED` / `SERVICE_ARCHIVED` | booking or rescheduling with an archived resource |
| 409 | `INVALID_APPOINTMENT_STATE` | any action on a COMPLETED/CANCELED/NO_SHOW appointment |
| 409 | `APPOINTMENT_COMPLETION_TOO_EARLY` | complete before `startAt` |
| 409 | `APPOINTMENT_NO_SHOW_TOO_EARLY` | no-show before `startAt` |
| 409 | `CONFLICT` | defensive fallback for any other exclusion violation (never exposes the constraint) |

## Idempotency

There is no `Idempotency-Key` in F27 (ADR-044). Be precise about what the conflict constraint does and does not
give you:

- **Duplicate booking of the same interval** (double-click, two tabs, two staff members): impossible — the
  second write gets `409 APPOINTMENT_CONFLICT`. This is a *safety* guarantee (never two bookings), not
  idempotency.
- **Network retry after a successful commit** (response lost): the retry also gets `409 APPOINTMENT_CONFLICT`,
  **not** the original `201` and resource. The client must re-read (list the day) to discover that its first
  attempt succeeded. That is the gap real idempotency would close.
- **Retry of a request that genuinely failed** (e.g. validation, timeout before commit): safe to retry — nothing
  was written.

Cancel/complete/no-show are naturally safe to repeat (the second call gets `409 INVALID_APPOINTMENT_STATE`; nothing is
applied twice). Public self-booking or third-party integrations must add a real `Idempotency-Key` (deferred).
