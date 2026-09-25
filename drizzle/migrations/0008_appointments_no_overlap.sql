-- F27 (ADR-044): Appointment booking-conflict enforcement.
-- Hand-written (drizzle-kit generate --custom): Drizzle's pg-core DSL has no
-- EXCLUDE builder and no range type. See src/db/schema/appointments.ts.
--
-- btree_gist supplies the GiST equality operator class for uuid, so the
-- tenant + professional keys can sit in the same GiST exclusion constraint
-- as the time range. Installed in Supabase's conventional `extensions`
-- schema. NOTE: the physical Postgres database is currently shared with UL
-- Platform (docs/decisions.md OD-16, separate schemas); an extension is a
-- database-level object, inert unless used — no UL Platform table, schema or
-- code depends on it or is changed by it. Owned by Na Pista's migrations.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
--> statement-breakpoint
-- Invariant: for one organization and one Professional, no two appointments
-- whose status <> 'CANCELED' may overlap. Half-open [start_at, end_at):
-- adjacent appointments (10:00-11:00, 11:00-12:00) do not conflict.
-- Negative predicate: any future non-canceled state occupies by default.
-- Enforced on every INSERT and UPDATE by every writer; a concurrent
-- conflicting writer waits for the first transaction, then fails with
-- SQLSTATE 23P01 (mapped to 409 APPOINTMENT_CONFLICT by the domain service).
ALTER TABLE "na_pista"."appointments"
  ADD CONSTRAINT "appointments_professional_no_overlap"
  EXCLUDE USING gist (
    "organization_id" WITH =,
    "professional_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  ) WHERE ("status" <> 'CANCELED');
