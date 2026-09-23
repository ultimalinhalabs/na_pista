# Scheduling & Organization Settings API (F26)

ADR-039/040/041. Follows the same conventions as every other Na Pista module: `/v1` prefix, tenant-scoped
under `/organizations/:organizationId`, `requireTenantContext` + `requireCapability(catalog.enabled)` +
`requireAuthorized`, `{ data }` / `{ error: { code, message } }` envelope, no raw Postgres errors.

## Organization Settings

Kept structurally separate from `/professionals/:professionalId/schedule` below — it is an Organization-level
resource, not a Professional one, and exists solely to support Scheduling's timezone requirement today
(ADR-040).

### `GET /v1/organizations/:organizationId/settings`

Permission: `scheduling.read`. Returns `data: null` when the organization has never configured a timezone —
**never** a default row.

```json
{ "data": { "organizationId": "...", "timezone": "Africa/Luanda", "createdAt": "...", "updatedAt": "..." } }
```

### `PUT /v1/organizations/:organizationId/settings`

Permission: `scheduling.update`. Body: `{ "timezone": "Africa/Luanda" }` — an IANA identifier, validated
against the runtime's own timezone database. Upsert semantics: creates the row if none exists yet, replaces
it otherwise. Rejects a raw UTC offset (`"+01:00"`) or a nonexistent identifier with `400 VALIDATION_ERROR`.

## Schedule (persisted configuration)

"Schedule" = the stored weekly rules and date exceptions — read/write. Distinct from "availability" below,
which is computed and read-only (you cannot `PUT` availability directly, only the rules that produce it).

### `GET /v1/organizations/:organizationId/professionals/:professionalId/schedule`

Permission: `scheduling.read`. Returns the Professional's weekly recurring rules, sorted by `dayOfWeek` then
`startLocalTime`.

```json
{
  "data": [
    { "id": "...", "organizationId": "...", "professionalId": "...", "dayOfWeek": 1, "startLocalTime": "08:00", "endLocalTime": "12:00", "createdAt": "...", "updatedAt": "..." },
    { "id": "...", "organizationId": "...", "professionalId": "...", "dayOfWeek": 1, "startLocalTime": "13:00", "endLocalTime": "17:00", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

`dayOfWeek`: `0` = Sunday .. `6` = Saturday. `startLocalTime`/`endLocalTime`: `"HH:mm"`, wall-clock local time
— never a UTC-anchored value (ADR-040).

### `PUT /v1/organizations/:organizationId/professionals/:professionalId/schedule`

Permission: `scheduling.update`. **Whole-set replacement** (ADR-039 D10) — the entire week is sent every
time; the previous set is atomically discarded and replaced in one transaction. Never a partial patch.

```json
{ "rules": [{ "dayOfWeek": 1, "startLocalTime": "08:00", "endLocalTime": "12:00" }, { "dayOfWeek": 1, "startLocalTime": "13:00", "endLocalTime": "17:00" }] }
```

An empty `rules` array is valid and means "closed every day" (ADR-039 D33). Multiple intervals per day are
supported (that is how a lunch break is represented — no dedicated Break concept). Adjacent intervals
(`08:00-12:00`, `12:00-17:00`) are accepted as two distinct rows, never merged. Validation (`400
VALIDATION_ERROR`): malformed `"HH:mm"`, `dayOfWeek` outside `0-6`, zero-length or reversed intervals
(overnight intervals like `22:00-02:00` are **not supported** — rejected, never silently transformed),
overlapping intervals on the same day. On success, returns the new rule set (`201`-shaped semantics via
`200`, matching a replace, not a create).

## Schedule Exceptions

Individual resources — created/removed one at a time, never a bulk replace (ADR-039 D24: exceptions are
sparse, independent, date-keyed facts, unlike the weekly rule set).

### `GET /v1/organizations/:organizationId/professionals/:professionalId/schedule/exceptions`

Permission: `scheduling.read`. Returns every exception row for the Professional, sorted by `date` then
`startLocalTime`.

### `POST /v1/organizations/:organizationId/professionals/:professionalId/schedule/exceptions`

Permission: `scheduling.create`. Body:

```json
{ "date": "2026-09-28", "startLocalTime": "09:00", "endLocalTime": "14:00" }
```

or, to mark a date fully unavailable (a closed-marker row):

```json
{ "date": "2026-12-25" }
```

`startLocalTime`/`endLocalTime` must both be present (an interval row) or both absent (a closed-marker row)
— providing exactly one is `400 VALIDATION_ERROR`. **This exception, once created, completely replaces the
weekly rule for that date** — never a merge (ADR-039 D4/D14; see the worked example in `docs/f26a-report.md`
§7). Errors: `409 CONFLICT` if a closed-marker already exists for that date, or if the date already has
interval rows and you attempt to add a contradictory closed-marker (and vice versa); `409 CONFLICT` on a
duplicate closed-marker (real DB unique-violation translation, same mechanism as `professional_services`);
`400 VALIDATION_ERROR` on overlapping interval exceptions for the same date. Returns `201` with the created
row.

### `DELETE /v1/organizations/:organizationId/professionals/:professionalId/schedule/exceptions/:exceptionId`

Permission: `scheduling.update`. Physical delete of one exception row, by its own id. `200 { "removed": true
}` on success; `404 NOT_FOUND` if the exception doesn't exist (including on a second delete attempt —
idempotent-safe, never a silent no-op). **Always allowed regardless of the Professional's archived status**
(mirrors `professional_services` disassociation).

## Availability (computed, read-only)

### `GET /v1/organizations/:organizationId/professionals/:professionalId/availability?from=&to=&serviceId=`

Permission: `scheduling.read`. `from`/`to`: `"YYYY-MM-DD"`, required, inclusive, `to >= from`, range capped
at 92 days (query-horizon protection, ADR-039/040 D34 — `400 VALIDATION_ERROR` if exceeded). `serviceId`:
optional UUID.

```json
{
  "data": {
    "timezone": "Africa/Luanda",
    "days": [
      { "date": "2026-09-28", "workingIntervals": [{ "start": "08:00", "end": "12:00" }] },
      { "date": "2026-09-29", "workingIntervals": [] }
    ]
  }
}
```

With `serviceId`, each day additionally carries `serviceStartTimes` — valid start times (stepped in 15-minute
increments) where the Service's full `durationMinutes` fits inside a working interval:

```json
{ "date": "2026-09-28", "workingIntervals": [{ "start": "08:00", "end": "09:00" }], "serviceStartTimes": ["08:00"] }
```

**This is working availability, not a booking guarantee** (ADR-041) — no Appointment conflicts exist to
subtract in F26 (F27's domain). A `GET` response must never be treated as a reservation; a future write must
revalidate availability at write time.

Errors: `409 TIMEZONE_NOT_CONFIGURED` if the Organization has no timezone set (fail-closed, never a silent
default); `409 PROFESSIONAL_ARCHIVED` if the Professional is archived (availability reads are blocked, the
underlying schedule rows are untouched); with `serviceId` — `404 NOT_FOUND` if the Service doesn't exist in
this tenant or isn't associated with this Professional (never leaks which case, and never duplicates
`professional_services` — always read live), `409 SERVICE_ARCHIVED` if the Service is archived.

## Authorization

| Permission | OWNER | ADMIN | MANAGER | STAFF |
|---|---|---|---|---|
| `scheduling.read` | ✅ | ✅ | ✅ | ✅ |
| `scheduling.create` (POST exception) | ✅ | ✅ | ✅ | ❌ |
| `scheduling.update` (PUT schedule, DELETE exception, PUT settings) | ✅ | ✅ | ✅ | ❌ |

No `scheduling.delete` — removal is gated by `scheduling.update`. No dedicated `organization_settings.*`
permission — settings reuse `scheduling.read`/`scheduling.update`.

## Entitlement

`catalog.enabled`, reused unchanged — no new Platform entitlement.

## Audit

`schedule.updated` (one event per whole-set `PUT`), `schedule.exception.created`, `schedule.exception.removed`,
`organization_settings.updated`. No audit event for availability reads (read-only computation).

## Usage

`api_requests`, recorded on `schedule.updated` and `schedule.exception.created` only — not on
`organization_settings.updated` (an F26A-frozen decision, not extended without re-opening it) and not on any
read.

## Tenant isolation

Every Scheduling table is `organizationId`-scoped with a composite FK back to `professionals`, mirroring
`professional_services`'s already-proven pattern. Cross-tenant `professionalId`/`serviceId` resolve `404`,
never leaking existence. Cross-tenant settings access resolves `403` (no membership) or is simply
independent per organization (each org's `GET .../settings` is scoped to its own row).
