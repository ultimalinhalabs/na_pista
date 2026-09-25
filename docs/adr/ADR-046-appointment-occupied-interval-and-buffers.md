# ADR-046 — Appointment Occupied Interval & Buffers

- **Estado:** Accepted — decision spike, no production code yet
- **Data:** 2026-09-25
- **Phase:** F28A (spike) — implementation slice F28F

## Context

**Current state (F27):** the conflict constraint `appointments_professional_no_overlap` excludes
`tstzrange(start_at, end_at, '[)')`. The visible booking interval and the interval that blocks the Professional are
the same thing. ADR-040 D11 already assigned the future owner of buffers: **`professional_services`** (a buffer is
pair-specific — a senior vs. junior professional, a haircut vs. a shave).

**Problem:** preparation/cleanup time must block the Professional without being part of what the customer booked:

```
customer-visible appointment   [start_at, end_at)              durationMinutes = end_at − start_at
occupied interval              [start_at − before, end_at + after)
```

**Hard PostgreSQL fact that shapes the design:** `timestamptz ± interval` is STABLE, not IMMUTABLE, so
`tstzrange(start_at − buffer, …)` can be neither an index expression nor a generated column. The occupied bounds
must be stored columns.

## Decision

1. **Buffer source:** `professional_services.buffer_before_minutes` / `buffer_after_minutes`,
   `integer NOT NULL DEFAULT 0`, `CHECK (0 ≤ x ≤ 240)` (ADR-040 D11, not reopened). No Service-level,
   Professional-level or Organization-level buffer; no combination rules.
2. **Resolution at booking:** `before` = buffer_before of the (responsible Professional, **first** service) row;
   `after` = buffer_after of the (responsible Professional, **last** service) row (ADR-045 lines). No buffers
   *between* services inside one appointment (deferred).
3. **Snapshot on `appointments`:** `buffer_before_minutes`, `buffer_after_minutes` (`integer NOT NULL DEFAULT 0`) —
   frozen at booking like the duration; later changes to `professional_services` never move existing appointments.
   **Preserved on reschedule** (the same booking moves; it is not re-quoted — the ADR-042 rule for duration).
4. **Stored occupied bounds:** `occupied_start_at`, `occupied_end_at` (`timestamptz NOT NULL`), written by the domain
   service, with an exact database CHECK:
   `extract(epoch from (start_at − occupied_start_at)) = buffer_before_minutes * 60 AND
    extract(epoch from (occupied_end_at − end_at)) = buffer_after_minutes * 60`
   (`timestamptz − timestamptz` and `extract(epoch from interval)` are immutable — proven accepted and enforced by the
   F28A probe, report §3.3). The database therefore guarantees the stored occupied interval can never disagree with
   the visible interval + buffers.
5. **Conflict authority redefined, same name:** `appointments_professional_no_overlap` becomes
   `EXCLUDE USING gist (organization_id WITH =, professional_id WITH =,
    tstzrange(occupied_start_at, occupied_end_at, '[)') WITH &&) WHERE (status <> 'CANCELED')`.
   Because `occupied ⊇ visible` (buffers ≥ 0), the new constraint **never admits a pair the F27 constraint rejected** —
   the invariant only gets stronger. With zero buffers it is behaviourally identical to F27.
6. **`durationMinutes` is unchanged** (`end_at − start_at`, what the customer booked). The API adds
   `bufferBeforeMinutes`, `bufferAfterMinutes`, `occupiedStartAt`, `occupiedEndAt`.
7. **Availability:** the **occupied** interval must fit inside one working interval. Implemented by calling the
   unchanged `computeAvailability` with `durationMinutes = before + Σ services + after` and interpreting each returned
   start time as the *occupied* start: visible start = occupied start + before. Consequence (accepted, documented): with
   a non-zero *before* buffer, offered visible start times are shifted off the round grid by that buffer (e.g. 08:10).
   After-buffers — the common case — keep round start times.
8. **Bookable slots** subtract appointments by their **occupied** intervals (the GiST index already covers them after
   the redefinition).

### Migration strategy (single additive migration; one constraint swap)

In one migration transaction: add the four `appointments` columns (`buffer_* DEFAULT 0`; `occupied_*` added nullable,
backfilled `= start_at / end_at`, then `SET NOT NULL`), add the CHECK, add the two `professional_services` columns
(default 0), then **drop and re-add** `appointments_professional_no_overlap` on the occupied columns. The re-add
validates every existing row; with zero buffers the backfilled ranges are identical to the old ones, so it cannot
fail on data F27 accepted. Rollback: re-create the F27 definition (still valid for all data, since visible ⊆ occupied).

### Impacts

- **API:** new read-only fields above; `professional_services` association endpoints gain optional
  `bufferBeforeMinutes`/`bufferAfterMinutes` (PATCH on the association — gated by `professionals.update`, the existing
  owner of associations, ADR-037). Clients never send occupied bounds.
- **UI:** association rows get two small numeric inputs; appointment detail shows "preparação/limpeza" when non-zero;
  the day view keeps showing the visible interval.
- **Tenant isolation / authorization:** unchanged mechanisms; buffers are configuration of an existing tenant-scoped row.
- **Audit:** `professional_service.updated` (new action on the existing association resource) when buffers change;
  `appointment.created` metadata includes the resolved buffers.
- **Usage:** unchanged.
- **Error mapping:** unchanged code (`APPOINTMENT_CONFLICT`), same constraint name — `mapBookingWriteError` needs no
  change for this ADR.
- **Testing:** unit (occupied computation, availability with buffers, off-grid visible starts with before-buffer);
  integration (CHECK rejects inconsistent bounds via raw insert; booking inside another appointment's after-buffer →
  409; adjacency at the occupied boundary allowed; buffer change never moves existing appointments; reschedule
  preserves buffers); concurrency (the F27 matrix re-run on occupied ranges); migration test that the swapped
  constraint exists with the new definition.

## Alternatives

- **Buffers on Service** — rejected by ADR-040 D11 (not professional-specific); not reopened.
- **Generated columns / expression index for the occupied range** — impossible (STABLE operator).
- **A second constraint on occupied bounds, keeping the F27 one** — rejected: strictly redundant (occupied ⊇ visible),
  one more GiST index to maintain for zero extra protection.
- **Applying buffers only in availability, not in the constraint** — rejected: availability is advisory; a buffer
  that the authoritative write ignores is a buffer that can be double-booked.

## Consequences

- (+) "Appointment duration ≠ occupied interval" is explicit, stored and DB-checked.
- (+) Establishes the occupied-interval columns that every additional conflict authority (ADR-047) cascades from.
- (−) One constraint definition changes (same name, strictly stronger) — the only non-purely-additive DDL in F28;
  justified above and reversible.
- (−) Before-buffers shift visible start times off the round grid.

## Deferred

Inter-service buffers, organization-default buffers, resource turnover buffers (ADR-047 resources use the same
occupied interval in F28).
