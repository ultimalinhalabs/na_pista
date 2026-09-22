# ADR-020 — Product (and Category) Lifecycle

- **Estado:** Accepted — implemented and E2E-tested
- **Data:** 2026-09-22

## Context
F20 brief §7/§26 ask for defined states, transitions, who may execute them, and the effect on reading and on
a future Orders module — without inventing an excessive workflow.

## Decision
Two states only: `ACTIVE` (default, listed and usable) and `ARCHIVED` (hidden from the default list filter,
still readable by id, still holds its history). `DELETE /products/:id` and `DELETE /categories/:id` perform
this transition — **never a physical `DELETE FROM`** — audited as `product.deleted`/`category.deleted` (the
operation the caller asked for), even though the effect under the hood is a status change. `PATCH` can also
set `status` directly (e.g. to un-archive), gated by the same `products.update`/`categories.update` permission
as any other field change — no separate "restore" endpoint invented for this slice.

**No `INACTIVE` state.** The brief's own example (`ACTIVE/INACTIVE/ARCHIVED`) was deliberately not copied
as-is: without an Orders module, a third state between "listed and usable" and "archived" has no distinct
behavior to define yet — the obvious candidate meaning ("temporarily not purchasable, but still cataloged")
only makes sense once purchasing exists. Adding it now would be exactly the "workflow excessivo" the brief
warns against (§7). Aditive later, once Orders defines what it should mean.

**Effect on reading:** `GET` by id always returns the resource regardless of status (so "the record still
exists" is always answerable) — proven in
`tests/e2e/category-and-product-lifecycle.test.ts` ("DELETE archives, never physically deletes"). `GET`
(list) defaults to `status=ACTIVE` in the UI, but the API's own default is "no filter" — the caller decides.

**Effect on a future Orders module:** deferred, undecided by design (Orders is out of scope — F20 brief §32).
Whatever Orders eventually does with an archived product's line items is that module's own decision to make
when it exists, not one to pre-guess here.

**Who may execute:** the same permission tier as any other mutation (`products.delete`/`categories.delete`,
OWNER/ADMIN only in the seed — one tier stricter than plain `update`, matching the Platform's own posture for
`organization.delete`).

## Alternatives
`DELETE` as a true SQL delete — rejected outright (F20 brief §26, "não assumir DELETE físico"; a future Orders
module needs to resolve historical references). A three-way `ACTIVE/INACTIVE/ARCHIVED` state machine copied
verbatim from the brief's own example — rejected for the reason above (no defined meaning yet).

## Consequences
- (+) Reversible by construction — archiving is never data loss.
- (+) No orphaned foreign keys anywhere (a product's `categoryId` survives the category being archived; an
  order's future product reference — not built — would similarly survive a product being archived).
- (−) `ARCHIVED` products/categories are excluded from nothing at the database level except the UI's own
  default filter — a caller that forgets to filter sees them. Deliberate (never hide data by default at the
  API layer; the caller decides), not an oversight.
