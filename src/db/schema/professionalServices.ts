import { foreignKey, index, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { naPistaSchema } from "./categories.js";
import { professionals } from "./professionals.js";
import { services } from "./services.js";

/**
 * ADR-037: a real N:M join table — never `service.professionalId`,
 * never `professional.serviceId`. Surrogate `id uuid PK` (consistent
 * with every other table in this codebase, including `order_items`,
 * which has an equally-valid natural composite key candidate and still
 * gets its own surrogate id).
 *
 * Tenant safety is structural, not just application-level: two
 * composite foreign keys, BOTH keyed off this table's own
 * `organization_id` — the exact mechanism `order_items` already proves
 * for referencing two different tables safely. A row can only ever
 * reference a Professional and a Service that both belong to the same
 * Organization as this row itself, enforced by Postgres.
 *
 * `UNIQUE(organization_id, professional_id, service_id)` prevents a
 * duplicate association (-> 409 CONFLICT at the service layer) and
 * doubles as the index for "list this Professional's Services"
 * (a query filtering on the leading columns `(organization_id,
 * professional_id)` uses this same index — no separate index needed).
 *
 * No `status` column (ADR-037) — the association exists or it doesn't.
 * No `updatedAt` — the row is never mutated, only created or removed
 * (a physical DELETE, the one place in this domain that happens —
 * mirrors `OrderItem`'s own precedent: a pure join/line record with no
 * historical value of its own once removed, since the Professional and
 * Service rows it referenced are never themselves physically deleted).
 * `ON DELETE NO ACTION` on both FKs (this codebase's universal default,
 * moot here since neither side is ever hard-deleted).
 */
export const professionalServices = naPistaSchema.table(
  "professional_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    professionalId: uuid("professional_id").notNull(),
    serviceId: uuid("service_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("professional_services_org_prof_service_unique").on(table.organizationId, table.professionalId, table.serviceId),
    index("professional_services_org_professional_idx").on(table.organizationId, table.professionalId),
    foreignKey({
      columns: [table.organizationId, table.professionalId],
      foreignColumns: [professionals.organizationId, professionals.id],
      name: "professional_services_professional_org_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.serviceId],
      foreignColumns: [services.organizationId, services.id],
      name: "professional_services_service_org_fk",
    }),
  ],
);
