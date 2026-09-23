# ADR-036 — Professional Domain Model

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-23
- **Phase:** F25A (spike)

## Context
F24A/ADR-035 already established the four-way boundary (`Service = WHAT`, `Professional = WHO`, `Scheduling =
WHEN`, `Appointment = the actual booking`) and named a future `professional_services` N:M relationship without
building any of it. F25A must now close Professional's own minimum model — without cloning Product or Service
(F25A brief's own explicit instruction) and without assuming a Professional is a platform User.

## Decision

**Minimum model:**
```
Professional {
  id
  organizationId
  name              -- required, 1-200 chars, no uniqueness constraint
  description?      -- optional, plain text, ≤2000 chars — operational note, not marketing copy
  phone?             -- optional, same loose international-shape validator as Customer.phone
  email?             -- optional, same validator as Customer.email
  status             -- ACTIVE | ARCHIVED, default ACTIVE
  createdAt
  updatedAt
}
```
Each field evaluated individually (F25A brief §4's own requirement), not assumed:

- **`name`** — necessary (a Professional must be identifiable/displayable, matching every catalog-shaped
  entity in this codebase). Domain, not presentation. Not sensitive. Not nullable. Length bound (200) matches
  every other module's identical convention — not a new one invented for Professional.
- **`description`** — necessary for a real, demonstrated use case: an operational note about a professional's
  specialization, shown alongside their name when a business configures who performs what. Optional, plain
  text only (no rich text/HTML, F25A brief §7), ≤2000 chars matching Product/Customer/Service's identical
  bound.
- **`phone`/`email`** — optional, informative only, **never authentication identity** (F25A brief §5/§25's
  explicit instruction). Reuse Customer's exact validators (`phoneSchema`/`emailSchema` from
  `customers/schemas.ts`, exported and imported — not duplicated) rather than inventing new ones.
- **`status`** — `ACTIVE | ARCHIVED` only, the same two-state lifecycle every module uses. No
  `ON_LEAVE`/`BUSY`/`AVAILABLE`/`VACATION`/`OFFLINE` — those describe a professional's real-time scheduling
  state, which belongs entirely to F26 (Scheduling), never to the catalog record itself.

**Professional is explicitly NOT:** a Platform User, a Membership, a Customer, a Service, an Appointment, a
Schedule/Calendar. It is a Na Pista domain entity representing an operational resource — a person who performs
one or more cataloged Services. **A Professional does not require a Supabase/Auth account.** No `userId` (or
`platformUserId`) column is added in this phase — F25A found no demonstrated need for one (F25A brief §25's
explicit instruction: "não criar `professional.userId` nesta fase sem necessidade demonstrada").

**Identity/name rules (F25A brief §6):** no uniqueness constraint on `name` — the exact same reasoning
ADR-024 already applied to `Customer.name` and ADR-033 applied to `Service.name`: two Professionals may
legitimately share a name (a coincidence, or genuinely two different people), and a real business's data
should not be rejected over it. Case-sensitivity: stored as trimmed input, no case-folding — "João Silva" and
"joão silva" are two distinct stored values; the system does not attempt to resolve whether they denote the
same person (a data-entry/business concern, not a system-enforced identity rule).

**Contact uniqueness (F25A brief §5):** no uniqueness constraint on `phone`/`email` either — the same
reasoning ADR-024 already gives for `Customer`: a shared reception line, or two professionals without
individual contacts yet configured, are legitimate states, not errors.

**Privacy note (F25A brief §30):** `phone`/`email`/`description` are personal data about a real individual
(more directly than `Customer`'s own contact fields, which describe an end-customer relationship). No legal/
retention framework is built here — this remains F18's own still-open OD-22, unchanged, the same posture
`ADR-026`/F21's report already took for `Customer`. Technical handling matches every other module: no special
redaction in API/UI, never included in audit metadata (opaque ids only).

## Alternatives

**Cloning `Product`'s or `Service`'s exact shape onto Professional** — rejected (F25A brief's own explicit
instruction, "não copiar Product ou Service cegamente"): Professional has identity/contact semantics neither
has, and lacks Service's pricing/duration semantics entirely.

**A `professional.userId` FK to the Platform's `users` table now** — rejected: no demonstrated requirement;
would conflate an operational catalog resource with an authentication identity, exactly the mixing F25A brief
§25 warns against. If a future login capability is needed, the correct shape (documented, not built) mirrors
`Customer`'s own already-established pattern (`domain-model.md` §4): a nullable `platformUserId`, linked
explicitly by the account holder, **never** by automatic email matching (which risks attaching data to the
wrong identity).

**Uniqueness on `name`, `phone`, or `email`** — considered, rejected: no business reason demonstrated, and it
would reject legitimate real-world data the same way it would for `Customer`.

**Additional lifecycle states (`ON_LEAVE`, `BUSY`, etc.)** — rejected; these describe scheduling
availability, not catalog membership, and belong entirely to F26 (see ADR-038).

## Consequences
- (+) Professional is fully independent of Platform identity — a business can catalog its staff/contractors
  as operational resources without any of them ever needing to sign in to anything, matching the exact spirit
  of `Customer`'s own identity independence (ADR-025).
- (+) The future optional link to a real Platform User (if ever required) is additive — a nullable FK, no
  redesign, following `Customer`'s own proven template.
- (−) Two data-entry duplicates of the same real person (e.g., a typo'd re-creation) are not prevented by the
  database — an accepted, deliberate trade-off matching every other named-entity module in this codebase.

## Future extension path
An optional `platformUserId` (nullable, explicit-link-only) the moment a real login requirement for
Professionals is demonstrated — F25A's own explicit non-decision, not silently assumed either way.
