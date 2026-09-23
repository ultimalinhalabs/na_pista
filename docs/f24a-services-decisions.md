# F24A — Services Domain Decisions & Architecture Spike

> **Decision spike. No Service/Professional/Scheduling/Appointment production code is implemented in this
> phase.** Every decision below is evidence-based (prior reports/ADRs, real code inspection) and closes
> exactly what F24 needs — nothing more. Full reasoning/alternatives live in
> [ADR-033](adr/ADR-033-service-domain-model.md)..[ADR-035](adr/ADR-035-service-professional-scheduling-boundary.md);
> this document is the consolidated, implementation-facing summary plus the F24 contract.

## 1. Executive summary

F24 will implement Na Pista's **service catalog** — `Service` alone, deliberately not Professionals,
Scheduling, or Appointments (those are F25/F26/F27). This phase closes the decisions required to build it
without inventing business semantics mid-coding:

- **Service is not a Product clone.** It shares Product's proven *infrastructure* (tenant repository, money
  validation, status lifecycle, audit/usage/authorization/entitlement machinery) but not its *domain shape* —
  no categories, no variants, a duration concept Product never had.
- **Duration** is a plain positive integer, `durationMinutes` — a deliberate, reasoned exception to the
  "money/quantity are decimal strings" convention, since integers have no float-precision problem to solve.
- **Pricing/currency** reuse F23A's money architecture (ADR-029/030/031) **exactly**, extended to Service with
  zero new decisions: `numeric(14,2)`, nullable, no currency column, `NULL` ≠ `0`.
- **Service has zero reference to Professional, Customer, or a calendar** — the catalog stays fully
  independent and shippable in F24 alone.
- **Lifecycle** is the same two-state `ACTIVE|ARCHIVED` every prior module uses — no new state machine.
- **No categories, no variants, no buffer time, no location** — all explicitly deferred, each with a named,
  additive future path, none built merely because Product has an analogue.

This document, together with ADR-033..035, is the package F24 implements directly from — see §21 "F24
implementation contract."

## 2. Service model (ADR-033)

```
Service {
  id
  organizationId
  name              -- required, 1-200 chars, no uniqueness
  description?      -- optional, plain text, ≤2000 chars
  durationMinutes    -- required, integer > 0
  price?             -- numeric(14,2), nullable
  status             -- ACTIVE | ARCHIVED, default ACTIVE
  createdAt
  updatedAt
}
```
No `categoryId`, no `professionalId`, no `customerId`, no quantity/stock/units, no location/branch/room. Each
exclusion is a reasoned decision (ADR-033), not an oversight — see §10/§11/§12/§13 below.

## 3. Duration model (ADR-034)

`durationMinutes integer`, `CHECK (duration_minutes > 0)`, no upper bound, any positive integer allowed — not
constrained to multiples of 15/30/60 (booking-grid quantization is Scheduling's future concern, F24 brief
§9). API representation: a **plain JSON integer**, not a decimal string — a deliberate exception to the
money/quantity string convention, justified because integers within any realistic service-duration range have
no IEEE-754 precision problem for that convention to solve. **No buffer/preparation/cleanup time in Service**
(F18's OD-09, still open, narrowed here) — buffer plausibly varies by professional or location, neither of
which exists yet; deferred to whichever future module actually owns it.

## 4. Pricing model (ADR-034, reusing ADR-029/031 exactly)

`Service.price numeric(14,2)`, nullable. `NULL` ("not yet priced") and `0` ("deliberately free") are distinct,
both valid — identical semantics to `Product.price`. `CHECK (price IS NULL OR price >= 0)`. No price history,
no price lists, no multi-currency — same minimum-model reasoning ADR-031 already established for Product,
extended without modification.

## 5. Currency (ADR-034, reusing ADR-030 exactly)

**No `currency` column on `Service`.** A Service's price is denominated in the Organization's single operating
currency (`AOA` today) — implicit, never redundantly stored, for the identical "avoid a disagreement state"
reasoning ADR-030 already gives for Product. F24A found no Service-specific reason to diverge from the
established Organization-level model (F24 brief §12's own explicit test).

## 6. Future price/duration snapshot contract (F27 — documented now, not built)

The same historical-integrity principle ADR-031 established for `OrderItem` applies to F27's future
"booked service" record: it must snapshot `serviceId`, `serviceName`, `unitPrice`, and `durationMinutes` at
Appointment-creation time, and never re-derive any of them from the live `Service` row afterward — a later
Service rename, price change, or duration change must never alter a past Appointment's historical record.
`durationMinutes` in the snapshot is a Service-specific addition `OrderItem` never needed (a booked
Appointment's actual length is itself a fact worth preserving historically). Not implemented in F24.

## 7. Free and unpriced Services

`price = 0` is explicitly valid (e.g., a complimentary consultation) — distinct from `price = NULL` ("not yet
configured commercially"), following Product's exact ADR-031 precedent, no Service-specific reason found to
diverge. A Service may exist unpriced; the future F27 contract must reject adding an unpriced Service to a new
Appointment (mirroring `PRODUCT_PRICE_REQUIRED`'s exact posture for Orders) — not implemented now, but the
`ProductPriceRequiredError`-equivalent behavior is the named template for F27 to follow.

## 8. Lifecycle

`ACTIVE | ARCHIVED` only — no third state, mirroring ADR-020/026. An archived Service: **readable** for
history (a future Appointment referencing it stays valid), **not selectable** for a new booking once
Appointments exist (mirrors `ProductArchivedError`'s posture, ADR-031/F23), **excluded** from the default
active-catalog list (`status=ACTIVE` filter), **never physically deleted**.

## 9. Professional boundary (ADR-035)

Service has **zero reference to Professional** in F24 — no column, no FK. Not every Service necessarily
requires one (F24 brief §19's own example: an automated/self-service offering) — no universal invariant
forces the relationship, so none is assumed. The future `Service ↔ Professional` relationship (F25) is a
separate `professional_services` join table (composite-FK both sides, tenant-safe, matching ADR-021's proven
pattern) — **not created now**, since `professionals` doesn't exist yet; purely additive when F25 arrives, no
`Service` redesign required.

## 10. Scheduling boundary (ADR-035)

Service provides exactly one input to future Scheduling: `durationMinutes`. Scheduling (F26) computes *when*
(`start + durationMinutes = end`, against a specific Professional's availability); **Service never stores
`startTime`/`endTime`** — it is a catalog definition, never a calendar event. `WorkingHours`/`TimeOff`/computed
availability (F18 SD-3) are entirely Scheduling's domain, untouched by F24.

## 11. Appointment boundary (ADR-035)

A future Appointment (F27) will reference `Service`, `Professional`, and `Customer` together — none of which
reference each other directly today. Snapshot fields Appointment consumes from Service: `id`, `serviceName`,
`unitPrice`, `durationMinutes` (see §6), plus a status check at booking time to reject archived Services. Per
F18 SD-5, one Appointment = one Service remains the v1 assumption (multi-service stays OD-09, unchanged here).

## 12. Categories — deferred (ADR-033)

**No `ServiceCategory` in F24.** Deliberately not copied from Product: Product got `Category` because F20's
own brief explicitly asked for "Categories + Products" together; nothing in F24's brief demonstrates an
equivalent need for Service grouping yet (F24 brief §20's own instruction: "do not create categories merely
because Products have them"). Deferred with a named, additive extension path (a nullable `serviceCategoryId`
FK, composite-tenant-safe), not built speculatively.

## 13. Variants/packages/quantity/location — out of scope (ADR-033)

No variant engine ("Haircut" vs. "Haircut + Beard" are just two independent `Service` rows). No bundling. No
inventory-like quantity/stock/units (Services are capacity-based via future Scheduling, not stock-based). No
location/branch/room/chair (deferred to Scheduling/business configuration if ever justified). None of these
have a demonstrated requirement in F24's own scope.

## 14. Authorization

`services.read` (all roles — matches every module's read tier). `services.create`/`services.update`
(OWNER/ADMIN/MANAGER, identical — no distinction between the three, mirroring Inventory's/Orders' more recent
precedent rather than Product/Customer's older OWNER/ADMIN-only "delete" tier). **`services.update` gates
archiving/reactivating too** (via `PATCH { status }`, see §17) — **no separate `services.delete`**, per the
brief's own explicit instruction (§28: "do not blindly create delete permission... do not create a meaningless
services.delete"). This is a deliberate, reasoned departure from Product/Customer's own precedent (which does
have an OWNER/ADMIN-only delete-as-archive tier) — F24A found no Service-specific reason to restrict archiving
more tightly than any other write, and the brief's own language pushes toward the simpler model Inventory/
Orders already established.

## 15. Entitlement

Reuses `catalog.enabled` (ADR-022, unchanged) — no `services.enabled` invented, no UL Platform change, per the
brief's explicit instruction and every prior module's same posture.

## 16. Audit

`service.created`, `service.updated`, `service.archived`, `service.reactivated` — same transaction as the
mutation (ADR-023's established pattern). Archive/reactivate get **dedicated audit action names** even though
both are triggered by the same `PATCH` endpoint as any other field edit (§17) — audit describes *what happened
business-wise*, not *which HTTP verb was called*; the service layer distinguishes a status-only transition
from any other field change and picks the audit action accordingly. No customer or professional PII (neither
exists yet to leak) — opaque ids only, matching every prior module's posture.

## 17. Usage

`api_requests` meter (unchanged, no `services.created` meter invented). Recorded on `service.created` only —
**not** on every update. This follows Product/Customer's established "record on create only" convention
(rather than Inventory's/Orders' broader "record on every meaningful event"), because Service's lifecycle is a
simple two-state toggle like Product/Customer, not a multi-stage business process like an Order's confirm/
cancel/complete or an Inventory movement — there is no analogous sequence of meaningful *events* beyond
creation to record usage against.

## 18. Tenant isolation

`organization_id NOT NULL` on `services`; a repository requiring a resolved `TenantContext`, matching every
prior module exactly. Any future relationship (`professional_services`, a future `service_category_id`) must
use the same composite-FK, tenant-safe pattern ADR-021 already proved — restated, not re-decided.

## 19. API contract

```
GET    /v1/organizations/:organizationId/services              -- list (status/name-search/limit filters)
GET    /v1/organizations/:organizationId/services/:serviceId    -- detail
POST   /v1/organizations/:organizationId/services                -- create
PATCH  /v1/organizations/:organizationId/services/:serviceId    -- update, INCLUDING status transitions
```
**No `DELETE`, no dedicated `/archive`/`/reactivate` endpoints.** Decision (F24 brief §33's own explicit
choice point): Service's lifecycle is a simple two-state toggle — exactly the shape Product/Customer's
existing `PATCH { status }` mechanism already handles cleanly (their `DELETE` endpoints are redundant calls
into the identical archive logic `PATCH` can also reach). Reusing that exact, already-proven mechanism is
simpler than inventing dedicated lifecycle endpoints (Order's own choice, ADR-032) — which were justified
there by a genuine four-state machine with branching transitions Service does not have. **No generic `DELETE`
is exposed at all**, honoring the brief's explicit "avoid generic DELETE if the domain is historical"
instruction (§33), while still reusing Product/Customer's proven `PATCH`-status pattern rather than inventing
a third lifecycle-endpoint style.

**Create input:** `{ name, description?, durationMinutes, price? }` — never `id`/`organizationId`/`currency`/
`status`/`createdAt`/`updatedAt`.
**Update input:** `{ name?, description?, durationMinutes?, price?, status? }` — same protected-field
exclusions; `price: null` explicitly clears it.
**Response:** `{ id, organizationId, name, description, durationMinutes, price, status, createdAt, updatedAt }`
— no `currency` field (§5).
**List query:** `status?`, `q?` (name search, ILIKE, matching Product's exact convention), `limit?
(1-100, default 50)`.

## 20. UI contract

`/o/[organizationId]/services` — list (name, duration, price, status badge), create/edit form (name,
description, duration, price), an archive/reactivate action (a status-toggle button, matching Product's own
UI pattern — not a separate lifecycle page). **No calendar, no appointment creation, no availability display,
no professional-assignment UI** in F24 — all deferred to F25/F26/F27. Inherits `na-pista-console/DESIGN.md`
verbatim — no new visual language for Services (F24 brief §37/§38).

## 21. F24 implementation contract

**Service** (new table, tenant-scoped like every prior module):
- `id uuid PK`, `organizationId uuid NOT NULL`, `name text NOT NULL`, `description text NULL`,
  `durationMinutes integer NOT NULL` (`CHECK > 0`), `price numeric(14,2) NULL` (`CHECK (price IS NULL OR
  price >= 0)`), `status text NOT NULL DEFAULT 'ACTIVE'` (`ACTIVE|ARCHIVED`), `createdAt`, `updatedAt`.
- Indexes: `(organization_id, created_at)`, `(organization_id, status)` — matching the real query shapes
  every prior module actually runs (list-by-tenant-ordered-by-recency, default-active-filter).
- No FK to anything — Service has no relationships in F24.

**API:** GET list/detail, POST create, PATCH update (including `status`) — no DELETE, no dedicated lifecycle
endpoints (§19).

**Authorization:** `services.read` (all), `services.create`/`services.update` (OWNER/ADMIN/MANAGER) — no
`services.delete`.

**Entitlement:** `catalog.enabled`, unchanged.

**Audit:** `service.created`/`service.updated`/`service.archived`/`service.reactivated`, same transaction as
the mutation; the service layer picks `archived`/`reactivated` specifically for a status-only transition.

**Usage:** `api_requests`, recorded on `service.created` only.

**Tenant isolation:** `organization_id NOT NULL`; repository requires `TenantContext`.

**Money:** identical to Product — `numeric(14,2)` DB, decimal-string API, no currency column.

**Duration:** `integer` DB, plain JSON number API (not a decimal string) — see §3.

F24 does not need to make any further Service-domain decision to begin implementation.

## 22. Deferred decisions

- **Service categories** (`ServiceCategory`) — additive, the moment a real requirement appears (§12).
- **Buffer/preparation/cleanup time** — belongs to Professional config or Scheduling, neither of which exists
  yet (§3/ADR-034).
- **Service/Professional compatibility** (`professional_services`) — F25's own table, purely additive (§9).
- **Multi-service Appointments** (F18's OD-09) — unchanged, still open, not this phase's to close.
- **Booking-grid quantization** — Scheduling's (F26) own concern (§3).
- **Service location/branch/room** — no demonstrated requirement (§13).
- **A real `TenantSettings`/organization-currency table** — inherited limitation from F23A, unchanged here;
  Service's price will read whatever `Order.currency` eventually reads.

## 23. Unresolved questions

None that block F24. Every question the brief posed (§47) is answered with evidence or explicit reasoning
below (`docs/f24a-report.md` "Self review"); nothing was force-closed without support.
