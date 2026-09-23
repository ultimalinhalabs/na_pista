# ADR-033 — Service Domain Model

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F24A (spike)

## Context
F18's `domain-model.md` SD-1/SD-2 already sketched a Service concept conceptually (tenant-scoped,
`duration_minutes` obligatory, `price_minor` optional "same rule as PD-4"). F24A must turn this into a real,
minimum schema for F24 — without cloning `Product` (F24 brief §3: "Do not model Service as a Product clone")
and without inventing fields no requirement demonstrates.

## Decision

**Minimum model:**
```
Service {
  id
  organizationId
  name              -- required, 1-200 chars, no uniqueness constraint
  description?      -- optional, plain text, ≤2000 chars
  durationMinutes    -- required, integer > 0
  price?             -- numeric(14,2), nullable (ADR-031's exact pattern)
  status             -- ACTIVE | ARCHIVED, default ACTIVE
  createdAt
  updatedAt
}
```

**Name:** required, no organization-scoped or global uniqueness. Two Services legitimately share a name (a
"Corte" at one price tier and another at a promotional price, or simply two entries not yet renamed) — the
same reasoning ADR-024 already applied to `Customer.name`. Length bound (200) matches `Product.name`/
`Category.name`'s existing convention, not a new one.

**Description:** optional, plain text only (≤2000 chars, matching `Product.description`) — no rich
text/HTML, keeping presentation concerns out of the domain (F24 brief §7's own instruction).

**Status:** `ACTIVE | ARCHIVED` only — the same two-state lifecycle every prior module uses (ADR-020/026),
not a new state machine. No `DRAFT`/`INACTIVE`/third state — nothing demonstrates a need for one (mirrors
ADR-018's own reasoning for Product: a state only earns existence once something gives it distinct meaning).

**What Service explicitly does NOT have, and why:**
- **No `Customer` reference** (F24 brief §25) — a Service is a reusable catalog definition; `Customer`
  belongs to the future `Appointment`, exactly as `Product` never references `Customer` and `OrderItem` is
  what links them.
- **No `Professional` reference** — see ADR-035.
- **No quantity/stock/units** (F24 brief §23) — Services are capacity-based (via future Scheduling), not
  stock-based; there is no analogue to `InventoryBalance` for a Service, and none is being invented here.
- **No location/branch/room/chair** (F24 brief §24) — no demonstrated requirement; deferred to
  Scheduling/business configuration if it ever becomes necessary.
- **No categories** (F24 brief §20) — deliberately **not** copied from Product. Product got `Category` from
  its own first slice because F20's brief explicitly asked for "Categories + Products" together; nothing in
  F24's brief demonstrates an equivalent need for Service grouping yet. Deferred, not built merely because
  Product has one (F24 brief §44: "do not copy Product logic blindly").
- **No variants/packages** (F24 brief §21/§22) — "Haircut" and "Haircut + Beard" are simply two independent
  `Service` rows, each with its own name/duration/price; no variant engine, no bundling mechanism. Mirrors
  ADR-018's own "no variants" decision for Product (OD-02), applied consistently to Service.

**Duration and pricing representation:** see ADR-034. **Professional/Scheduling/Appointment boundaries:** see
ADR-035.

## Alternatives

**Cloning `Product`'s exact shape (add `durationMinutes`/drop `categoryId`)** — rejected: Service has domain
semantics Product does not (duration, a future scheduling relationship) and lacks one Product has (no
demonstrated need for categorization yet); a shared base type would only paper over a real semantic
difference. F24 brief §44 explicitly warns against a generic "BusinessEntityService" abstraction built merely
to make the two modules look similar — reuse the proven *infrastructure* (tenant repository pattern, money
validation, status lifecycle, audit/usage/authorization/entitlement machinery), never the *domain semantics*.

**A `Service.categoryId` from day one "for consistency with Product"** — rejected; no requirement.

**Uniqueness on `Service.name` per organization** — considered, rejected: no business reason demonstrated,
and forcing it would reject legitimate near-duplicate offerings a real business might genuinely want.

## Consequences
- (+) Service is fully independent — buildable and testable in F24 with zero dependency on Professionals
  (F25), Scheduling (F26), or Appointments (F27).
- (+) Every deferred concept (categories, variants, buffer, location) has a named, additive extension path —
  none of them require a Service redesign if/when a real requirement appears.
- (−) A Service catalog with dozens of entries has no grouping/browsing aid yet (no categories) — acceptable
  for a first slice; the same additive path Category itself proved for Product (ADR-019) applies unchanged.

## Future extension path
`ServiceCategory` (if ever justified): same composite-FK pattern ADR-021 already established
(`service_category_id` nullable FK on `Service`, tenant-scoped, additive column — no migration of existing
rows needed). Service variants/packages: a distinct future concept, not an evolution of this model.
