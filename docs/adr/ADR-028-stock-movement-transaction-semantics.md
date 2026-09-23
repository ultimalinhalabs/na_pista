# ADR-028 — Stock Movement and Transaction Semantics

- **Estado:** Accepted — implemented, integration- and concurrency-tested against real PostgreSQL
- **Data:** 2026-09-23
- **Closes:** OD-05 (negative stock / backorder)

## Context
F22 required an explicit, tested decision on whether stock can go negative, how a movement changes the
balance without a lost-update race, and how movement + balance + audit stay atomic — the core invariant of
this slice (F22 brief §12/§13/§33).

## Decision

**Negative stock: not allowed, no backorders (OD-05, closed).** A decrease that would take
`availableQuantity` below zero fails atomically — `409 INSUFFICIENT_STOCK`, no partial effect: the balance is
unchanged and no movement row is inserted. Backorders are explicitly future Order behavior, not built here.

**Movement types, kept intentionally small (F22 brief §10):** `RECEIPT`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`
only. No `SALE`/`ORDER_RESERVATION`/`RETURN`/`TRANSFER`/... — those imply Order/Purchasing workflows that do
not exist yet; a future Orders module defines its own stock semantics against this same ledger rather than
this slice guessing them.

**Direction from `type`, never from sign (F22 brief §11):** the API always accepts a positive quantity;
`ADJUSTMENT_OUT quantity: 5` means "decrease by 5", never "quantity: -5". Prevents an ambiguous contract where
a client could send a negative number to an "increase" endpoint or vice versa.

**No direct quantity overwrite (F22 brief §15):** there is no `PATCH /inventory/:id`. The only way to change a
balance is `POST .../movements` — every quantity change is provably a movement, by construction, not by
convention.

**Atomicity: one transaction, two SQL statements, no application-level "read-check-write" (F22 brief §12/§13).**
`createMovement` (`src/modules/inventory/service.ts`) runs inside `db.transaction`:
1. Re-check the product's existence/archived status inside the transaction.
2. Apply the balance change with a single, self-contained SQL statement:
   - **Increase** (`RECEIPT`/`ADJUSTMENT_IN`): `INSERT ... ON CONFLICT (organization_id, product_id) DO UPDATE
     SET quantity = quantity + $delta` — creates the balance on the first `RECEIPT`, increments it otherwise,
     in one atomic upsert.
   - **Decrease** (`ADJUSTMENT_OUT`): `UPDATE ... SET quantity = quantity - $delta WHERE organization_id=$1
     AND product_id=$2 AND quantity >= $delta` — the sufficiency check is part of the SAME row-locking
     `UPDATE`, not a separate `SELECT` beforehand. If the guard fails, **zero rows are affected** and the
     function returns `undefined`; the service throws `InsufficientStockError` — never a caught Postgres error
     to translate, never a race window between checking and writing.
3. Insert the movement row, referencing the balance's own id.
4. Insert the audit event.

If any step fails, the whole transaction rolls back — the balance is exactly as it was, no orphaned movement,
no orphaned audit row. Usage recording happens *after* the transaction commits (fire-and-forget, ADR-023's
established posture — a usage-write failure never affects the mutation).

**Why this is concurrency-safe without `SELECT ... FOR UPDATE`.** A plain `UPDATE`/`INSERT ON CONFLICT`
statement already takes the row-level lock it needs for the duration of evaluating its own `SET`/`WHERE`
clause — a concurrent second `UPDATE` targeting the same `(organization_id, product_id)` row is blocked by
Postgres until the first transaction commits or rolls back, then re-evaluates its own `WHERE quantity >=
$delta` against the now-current value. This is a stronger guarantee against the classic "read 10, subtract 7,
write 3" lost-update race than `SELECT ... FOR UPDATE` + a separate application-level check would be, because
there is no separate read step for a second writer to interleave with at all — the check and the write are
literally the same statement. `inventory_balances_quantity_non_negative` (a real `CHECK` constraint) exists as
defense in depth, not as the primary mechanism.

**Proven, not asserted (F22 brief §32).** `tests/integration/inventory.test.ts`'s concurrency test starts a
product at a known balance and fires many concurrent `ADJUSTMENT_OUT` requests via real, parallel Postgres
transactions (through the real HTTP-independent service function, i.e., genuinely concurrent database
transactions, not sequential `await`s) that together demand more stock than exists. See
`docs/f22-report.md` "Concurrency" for the exact scenario and measured result — this ADR does not restate the
numbers so it never goes stale relative to the report.

## Alternatives
`SELECT ... FOR UPDATE` then an application-level `if (current - delta < 0) throw` then `UPDATE` — considered
and rejected in favor of the single-statement approach above: functionally equivalent locking behavior, but
with an extra round trip and a real (if usually small) window where the "check" and the "write" are visibly
two different statements a future maintainer could accidentally split across a transaction boundary. The
conditional `UPDATE` makes that class of bug impossible by construction.
Signed quantity input (`quantity: -5` for a decrease) — rejected (F22 brief §11, ambiguous contract).

## Consequences
- (+) The negative-stock invariant is enforced at three independent levels: the conditional `UPDATE`'s `WHERE`
  guard (primary), the `CHECK` constraint (defense in depth), and Zod rejecting non-positive input entirely
  (never even reaches the database as a candidate direction).
- (+) A future Orders module can reserve/fulfill stock by adding its OWN movement types and its OWN service
  logic on top of the same `inventory_balances`/`stock_movements` tables and the same atomic-update pattern —
  it does not need to touch or understand this transaction's internals.
- (−) `ADJUSTMENT_OUT` against a product with zero recorded balance (no `inventory_balances` row at all) and
  `ADJUSTMENT_OUT` against a product with genuinely insufficient stock produce the **same** `409
  INSUFFICIENT_STOCK` — deliberately not distinguished, since both mean "you cannot decrease by more than
  what's there" and a client gains nothing from telling them apart.
