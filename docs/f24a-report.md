# F24A Report — Services Domain Decisions & Architecture Spike

## Status

**COMPLETE.** F24A is a decision spike; its Definition of Done is a coherent, evidence-based decision package
— not running code. Every question the brief asked (§0–§46, self-review §47) is answered with either a
citation to prior work/code actually inspected, or explicit, reasoned architectural decision-making where no
prior precedent existed. Nothing was silently reinterpreted: where this phase departs from a prior module's
precedent (e.g., no `services.delete` tier, unlike Product/Customer's OWNER/ADMIN-only archive permission),
the departure is explicit and reasoned (ADR-033/§14 below), not accidental. No Service/Professional/
Scheduling/Appointment production code exists after this phase — confirmed by `git status`/`git diff` below.

## Decisions

See [`docs/f24a-services-decisions.md`](f24a-services-decisions.md) for the full package. Summary: Service is
a minimum catalog entity (`name`, `description?`, `durationMinutes`, `price?`, `status`) — **not** a Product
clone; duration is a plain positive integer (`durationMinutes`, JSON number, not a decimal string — a
deliberate, reasoned exception to the money/quantity string convention); pricing/currency reuse F23A's
architecture (ADR-029/030/031) with zero new decisions; Service has no reference to Professional, Customer, or
a calendar; no categories/variants/buffer/location in F24, each deferred with a named additive path; lifecycle
is the standard `ACTIVE|ARCHIVED`, reached via `PATCH { status }` (no DELETE, no dedicated lifecycle
endpoints — reusing Product/Customer's proven mechanism, not Order's); `services.update` covers
archive/reactivate (no separate `services.delete`, a deliberate departure from Product/Customer's own
precedent, reasoned in ADR-033/§14).

## Alternatives considered

Full reasoning per decision lives in each ADR's own "Alternatives" section. Highest-signal ones:
1. **Cloning Product's shape onto Service** — rejected; Service has domain semantics Product doesn't
   (duration) and lacks one Product has (no demonstrated categorization need) — ADR-033.
2. **Duration as a decimal string, matching money/quantity** — rejected; integers have no float-precision
   problem that convention exists to solve — ADR-034.
3. **A `bufferMinutes` field on Service now** — rejected; genuinely undecidable before Professional/Scheduling
   exist — ADR-034.
4. **`Service.professionalId` (single professional per service)** — rejected; contradicts the brief's own
   N:M example and forecloses SD-1's already-anticipated shape — ADR-035.
5. **Building `professional_services` now with a stub `professionals` table** — rejected; F24A is explicitly
   told not to implement Professionals in any form — ADR-035.
6. **Dedicated `/archive`/`/reactivate` lifecycle endpoints (Order's own pattern)** — considered, not chosen;
   Service's two-state lifecycle is a closer match to Product/Customer's simpler `PATCH`-status shape than to
   Order's four-state machine, which is what justified dedicated endpoints there — `f24a-services-decisions.md`
   §19.
7. **A `services.delete` permission mirroring Product/Customer's OWNER/ADMIN-only archive tier** — considered,
   not chosen; no Service-specific reason found to restrict archiving more tightly than any other write, and
   the brief's own language (§28) pushes toward Inventory's/Orders' simpler, more recent precedent.

## ADRs produced

- [ADR-033 — Service Domain Model](adr/ADR-033-service-domain-model.md)
- [ADR-034 — Service Duration and Pricing Model](adr/ADR-034-service-duration-and-pricing.md)
- [ADR-035 — Service / Professional / Scheduling / Appointment Boundary](adr/ADR-035-service-professional-scheduling-boundary.md)

Three ADRs, matching the brief's own suggested count and its "prefer fewer documents" instruction (§45) —
duration and pricing share one ADR since both are quantifiable Service attributes following an established
pattern (F23A's), while the domain-boundary decisions (Professional/Scheduling/Appointment) are genuinely
distinct architectural territory deserving their own document.

## F24 implementation contract

See [`docs/f24a-services-decisions.md`](f24a-services-decisions.md) §21 — reproduced there in full (Service
table/columns/constraints, API shape, authorization/entitlement/audit/usage contracts, money/duration
representation). Not duplicated here to avoid the two documents drifting apart.

## Known limitations

1. **No real `TenantSettings`/organization-currency table** — inherited from F23A, unchanged; Service's price
   will be denominated in whatever `Order.currency` eventually reads once that table exists.
2. **Buffer/preparation time has no home yet** — genuinely undecidable before Professional (F25) or Scheduling
   (F26) exist; a real limitation on what F26 can compute from Service data alone, not an oversight.
3. **No Service categorization** — a catalog of many Services has no grouping/browsing aid in F24; deferred,
   not silently dropped (same additive path Category itself proved for Product).

## Deferred decisions

Service categories, buffer/preparation time ownership, `professional_services` (F25's own table),
multi-service Appointments (F18's OD-09, still open), booking-grid quantization (F26's own concern), Service
location/branch/room. All named explicitly in `docs/f24a-services-decisions.md` §22, each with a stated
future owner.

## Self review (brief §47)

1. **What exactly is a Service?** A tenant-scoped catalog definition of an activity/capability that can be
   scheduled and performed — distinct from Product (a tangible/sellable catalog item) by having duration and
   a future scheduling relationship, and by lacking Product's categorization (ADR-033).
2. **What is the minimum Service schema?** `id, organizationId, name, description?, durationMinutes, price?,
   status, createdAt, updatedAt` — no more (ADR-033, `f24a-services-decisions.md` §2).
3. **How is duration represented?** `durationMinutes integer`, `CHECK > 0` (ADR-034 §3).
4. **What precision does duration use?** Whole minutes — no seconds, no fractional minutes; no requirement
   demonstrates a need for either (ADR-034).
5. **Is duration allowed to be arbitrary minutes?** Yes — any positive integer, not constrained to 15/30/60
   multiples; booking-grid quantization is explicitly Scheduling's future concern (ADR-034 §9).
6. **Does Service have a price?** Yes, optional (ADR-034 §4).
7. **Can price be NULL?** Yes — "not yet priced," distinct from `0` (ADR-034/ADR-031).
8. **Is zero price valid?** Yes — "deliberately free" (e.g. a complimentary consultation) (§7 of the
   decisions doc).
9. **What currency model applies?** F23A's — one currency per Organization, snapshotted only at the future
   transactional boundary (Appointment), never on the priced entity itself (ADR-030, extended by ADR-034).
10. **Where does currency come from?** The Organization's single operating currency (`AOA` today) — not
    stored on Service (§5).
11. **Is Service currency stored?** No — explicitly not, mirroring Product (§5).
12. **What happens when Service price changes?** Only future Appointments are affected; existing (once F27
    exists) Appointment records keep their own snapshotted price — current state only (ADR-034 §6).
13. **How will Appointment snapshot price?** `serviceName`/`unitPrice`/`durationMinutes` copied at
    Appointment-creation time, never re-read from the live Service afterward — documented now as F27's
    contract, not implemented (ADR-034 §6, `f24a-services-decisions.md` §6/§11).
14. **Can archived Services be read?** Yes — history-readable, never physically deleted (§8).
15. **Can archived Services be newly scheduled?** No, once Appointments exist — a documented future rejection
    (`PRODUCT_ARCHIVED`-equivalent posture), not enforced by any code in this phase since no booking exists
    yet (§8/§11).
16. **Does Service reference Customer?** No — Customer belongs to the future Appointment (ADR-033 §"What
    Service explicitly does NOT have").
17. **Does Service reference Professional?** No (ADR-035).
18. **Where is Professional compatibility represented?** A future, separate `professional_services` join
    table (F25), composite-FK tenant-safe, purely additive — not built now (ADR-035).
19. **Where does Scheduling begin?** Where "what" (Service) and "who" (Professional) meet "when" — Scheduling
    consumes `Service.durationMinutes` as its only input from this module (ADR-035 §10).
20. **Does Service contain calendar information?** No — no `startTime`/`endTime`, ever; a Service is a
    catalog definition, never a calendar event (ADR-035).
21. **Does Service contain buffer time?** No — deferred, undecidable before Professional/Scheduling exist
    (ADR-034 §"Buffer/preparation/cleanup time").
22. **Does Service need categories?** Not in F24 — no demonstrated requirement; deferred with a named
    additive path (ADR-033 §12).
23. **Are Service variants in scope?** No — separate named Services is the simplest initial rule; no variant
    engine (ADR-033 §13).
24. **What permissions control Service management?** `services.read` (all), `services.create`/
    `services.update` (OWNER/ADMIN/MANAGER); no `services.delete` (§14).
25. **What entitlement controls Service access?** `catalog.enabled`, unchanged, no new Platform entitlement
    (§15).
26. **What audit events exist?** `service.created`/`service.updated`/`service.archived`/`service.reactivated`
    (§16).
27. **What usage events exist?** `api_requests`, on `service.created` only (§17).
28. **What is the F24 API contract?** GET list/detail, POST create, PATCH update-including-status; no DELETE,
    no dedicated lifecycle endpoints (§19).
29. **What is the F24 UI contract?** `/o/[organizationId]/services` list + create/edit form + a status-toggle
    action; no calendar/booking/professional-assignment UI (§20).
30. **Can F25 implement Professionals without redesigning Service?** Yes — `professional_services` is purely
    additive, zero changes to `services`' own schema (ADR-035 "Consequences").
31. **Can F26 implement Scheduling without redesigning Service?** Yes — Scheduling only ever reads
    `durationMinutes`; introduces its own tables entirely (ADR-035).
32. **Can F27 implement Appointments without redesigning Service?** Yes — Appointments reference Service via
    new FKs and their own snapshot fields; `Service` itself needs no change (ADR-035).
33. **Is the Service domain independent from Customers?** Yes — no reference either direction; Customer
    belongs to the future Appointment (§25 of the decisions doc / ADR-033).
34. **Is the Service domain independent from Products?** Yes — no shared table, no FK between them; only
    proven, reusable *infrastructure* is shared (tenant repository pattern, money validation, status
    lifecycle, audit/usage/authorization/entitlement machinery), never domain semantics (ADR-033 "Alternatives",
    F24 brief §44's own instruction, honored explicitly).
35. **Does the decision preserve the Na Pista multi-tenant architecture?** Yes — `organization_id NOT NULL`,
    tenant-scoped repository requiring `TenantContext`, every future relationship specified to use the same
    composite-FK tenant-safe pattern ADR-021 already proved (§18 of the decisions doc).

All 35 answered with evidence or explicit architectural reasoning — marking **COMPLETE**.

## Platform changes

None. No UL Platform production code touched, no new entitlement requested (§15).

## Git

**Commits:** `na-pista` only (docs: ADR-033..035, `docs/f24a-services-decisions.md`, this report, ADR index
update). No `na-pista-console`/`ul-platform` changes — this phase produces no code of any kind, per its own
explicit instruction. **Push:** no remote configured for `na-pista` — no push, same posture as F19/F23A.

## Exact F24 next step

**F24 — Services Vertical Slice**: implement `Service` exactly per `docs/f24a-services-decisions.md` §21's
contract, reusing the tenant-scoped-repository/entitlement-gate/audit/usage pattern proven five times already
(Categories, Products, Customers, Inventory, Orders) and the exact money-validation pattern
`products/schemas.ts` already implements for `price`. No architectural decision should need to be made during
F24's implementation — every field, constraint, permission, audit action, and API shape is specified above.
