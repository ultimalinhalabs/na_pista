# Architectural Decision Records — Na Pista

Formato: **Context / Decision / Alternatives / Consequences**. Estado: *Accepted* (decorre do conceito oficial, do
CLAUDE.md ou do código real do Platform) · *Proposed* (recomendação desta fase, reversível) · *Superseded*.
Decisões ainda em aberto **não** são ADR: estão em [`../f18-review.md`](../f18-review.md#4-open-decisions) (F18)
e [`../decisions.md`](../decisions.md) (F19 — todas fechadas com evidência de runtime).

| ADR | Título | Estado | Fase |
|---|---|---|---|
| [001](ADR-001-na-pista-as-platform-application.md) | Na Pista como Application do UL Platform | Accepted | F18 |
| [002](ADR-002-organization-as-tenant-boundary.md) | Organization como Tenant Boundary | Accepted / mecanismos Proposed | F18 |
| [003](ADR-003-platform-vs-business-domain-boundary.md) | Platform vs Business Domain Boundary | Accepted | F18 |
| [004](ADR-004-modular-business-architecture.md) | Arquitectura de negócio modular | Proposed | F18 |
| [005](ADR-005-api-first.md) | API-first | Accepted | F18 |
| [006](ADR-006-supabase-auth-identity-authority.md) | Supabase Auth como autoridade de identidade | Accepted | F18 |
| [007](ADR-007-platform-entitlements.md) | Platform Entitlements | Accepted / vocabulário Proposed | F18 |
| [008](ADR-008-default-ui-vs-custom-ui.md) | Default UI vs Custom UI | Proposed | F18 |
| [009](ADR-009-customer-identity-boundary.md) | Customer identity boundary | Accepted / campos Proposed | F18 |
| [010](ADR-010-first-vertical-slice.md) | Primeiro vertical slice | Proposed | F18 |
| [011](ADR-011-service-identity.md) | Na Pista Service Identity | Accepted — runtime-proven | F19 |
| [012](ADR-012-user-membership-context.md) | Na Pista User/Membership Context | Accepted — runtime-proven | F19 |
| [013](ADR-013-application-level-authorization.md) | Application-level Authorization | Accepted — runtime-proven | F19 |
| [014](ADR-014-entitlement-consumption.md) | Entitlement Consumption | Accepted — runtime-proven | F19 |
| [015](ADR-015-tenant-isolation-strategy.md) | Tenant Isolation Strategy (RLS) | Accepted — runtime-proven | F19 |
| [016](ADR-016-service-scope-model.md) | Service Scope Model | Accepted — runtime-proven | F19 |
| [017](ADR-017-failure-and-fail-closed-strategy.md) | Failure and Fail-Closed Strategy | Accepted — runtime-proven | F19 |
| [018](ADR-018-product-domain-model.md) | Product Domain Model | Accepted — implemented | F20 |
| [019](ADR-019-category-model.md) | Category Model | Accepted — implemented | F20 |
| [020](ADR-020-product-lifecycle.md) | Product (and Category) Lifecycle | Accepted — implemented | F20 |
| [021](ADR-021-tenant-scoped-repository.md) | Tenant-scoped Repository | Accepted — implemented | F20 |
| [022](ADR-022-product-entitlement-enforcement.md) | Product Entitlement Enforcement | Accepted — implemented | F20 |
| [023](ADR-023-product-audit-usage.md) | Product Audit / Usage | Accepted — implemented | F20 |
| [024](ADR-024-customer-domain-model.md) | Customer Domain Model | Accepted — implemented | F21 |
| [025](ADR-025-customer-identity-platform-user-separation.md) | Customer Identity / Platform User Separation | Accepted — implemented | F21 |
| [026](ADR-026-customer-lifecycle.md) | Customer Lifecycle | Accepted — implemented | F21 |
| [027](ADR-027-inventory-model.md) | Inventory Model | Accepted — implemented | F22 |
| [028](ADR-028-stock-movement-transaction-semantics.md) | Stock Movement and Transaction Semantics | Accepted — implemented | F22 |
| [029](ADR-029-money-representation.md) | Money Representation | Accepted — implemented (F23) | F23A |
| [030](ADR-030-currency-model.md) | Currency Model | Accepted — implemented (F23) | F23A |
| [031](ADR-031-product-pricing-and-order-price-snapshot.md) | Product Pricing and Order Price Snapshot | Accepted — implemented (F23) | F23A |
| [032](ADR-032-order-inventory-boundary.md) | Order Lifecycle and the Order/Inventory Boundary | Accepted — implemented (F23) | F23A |
| [033](ADR-033-service-domain-model.md) | Service Domain Model | Accepted — implemented (F24) | F24A |
| [034](ADR-034-service-duration-and-pricing.md) | Service Duration and Pricing Model | Accepted — implemented (F24) | F24A |
| [035](ADR-035-service-professional-scheduling-boundary.md) | Service / Professional / Scheduling / Appointment Boundary | Accepted — implemented (F24) | F24A |
| [036](ADR-036-professional-domain-model.md) | Professional Domain Model | Accepted — implemented (F25) | F25A |
| [037](ADR-037-professional-service-relationship.md) | Professional-Service Relationship (`professional_services`) | Accepted — implemented (F25) | F25A |
| [038](ADR-038-professional-scheduling-appointment-boundary.md) | Professional / Scheduling / Appointment / Auth Boundary | Accepted — implemented (F25) | F25A |
