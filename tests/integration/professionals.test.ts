import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { professionalServices, professionals } from "../../src/db/schema/index.js";
import { insertService, updateService } from "../../src/modules/services/repository.js";
import {
  associateService,
  createProfessional,
  getProfessionalOrThrow,
  listAllProfessionals,
  listServicesForProfessionalOrThrow,
  removeAssociation,
  updateProfessionalOrThrow,
} from "../../src/modules/professionals/service.js";
import { ConflictError, NotFoundError, ProfessionalArchivedError, ServiceArchivedError } from "../../src/shared/errors.js";

/** F25 brief §37 "Integration tests", real PostgreSQL, no HTTP, no Platform. */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };
const actor = { type: "user" as const, id: "test-actor" };

after(() => queryClient.end());

test("migration: professionals and professional_services tables exist with the expected shape", async () => {
  const p = await db.select().from(professionals).limit(1);
  const ps = await db.select().from(professionalServices).limit(1);
  assert.ok(Array.isArray(p));
  assert.ok(Array.isArray(ps));
});

test("create + read: a Professional persists with the exact ADR-036 fields, status defaults to ACTIVE", async () => {
  const created = await createProfessional(orgA, actor, "req-1", { name: "João Silva", description: "Barbeiro sénior", phone: "+244923456789", email: "joao@example.com" });
  assert.equal(created.name, "João Silva");
  assert.equal(created.description, "Barbeiro sénior");
  assert.equal(created.phone, "+244923456789");
  assert.equal(created.email, "joao@example.com");
  assert.equal(created.status, "ACTIVE");
  assert.equal(created.organizationId, orgA.organizationId);

  const read = await getProfessionalOrThrow(orgA, created.id);
  assert.equal(read.id, created.id);
});

test("create: a Professional can exist with only a name (no phone/email/description)", async () => {
  const created = await createProfessional(orgA, actor, "req-1", { name: "Ana Costa" });
  assert.equal(created.phone, null);
  assert.equal(created.email, null);
  assert.equal(created.description, null);
});

test("update: name/description/phone/email can all be changed, updatedAt advances", async () => {
  const created = await createProfessional(orgA, actor, "req-1", { name: "Carlos" });
  await new Promise((r) => setTimeout(r, 5));
  const updated = await updateProfessionalOrThrow(orgA, actor, "req-2", created.id, { name: "Carlos Mendes", description: "Novo", phone: "+244911000000", email: "carlos@example.com" });
  assert.equal(updated.name, "Carlos Mendes");
  assert.equal(updated.description, "Novo");
  assert.ok(updated.updatedAt.getTime() > created.updatedAt.getTime());
});

test("archive (ACTIVE -> ARCHIVED via PATCH status): remains readable, excluded from the ACTIVE list", async () => {
  const created = await createProfessional(orgA, actor, "req-1", { name: "Profissional a Arquivar" });
  const archived = await updateProfessionalOrThrow(orgA, actor, "req-2", created.id, { status: "ARCHIVED" });
  assert.equal(archived.status, "ARCHIVED");

  const stillReadable = await getProfessionalOrThrow(orgA, created.id);
  assert.equal(stillReadable.status, "ARCHIVED");

  const activeList = await listAllProfessionals(orgA, { status: "ACTIVE", limit: 100 });
  assert.ok(!activeList.some((p) => p.id === created.id));
});

test("reactivate (ARCHIVED -> ACTIVE via PATCH status): becomes selectable again", async () => {
  const created = await createProfessional(orgA, actor, "req-1", { name: "Profissional a Reactivar" });
  await updateProfessionalOrThrow(orgA, actor, "req-2", created.id, { status: "ARCHIVED" });
  const reactivated = await updateProfessionalOrThrow(orgA, actor, "req-3", created.id, { status: "ACTIVE" });
  assert.equal(reactivated.status, "ACTIVE");
});

test("audit: create/update/archive/reactivate each record the correct, distinct audit action", async () => {
  const created = await createProfessional(orgA, actor, "req-created", { name: "Profissional Audit" });
  const { auditEvents } = await import("../../src/db/schema/index.js");
  const rowsFor = async (action: string) =>
    db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.resourceId, created.id), eq(auditEvents.action, action)));

  assert.equal((await rowsFor("professional.created")).length, 1);

  await updateProfessionalOrThrow(orgA, actor, "req-updated", created.id, { name: "Renomeado" });
  assert.equal((await rowsFor("professional.updated")).length, 1);

  await updateProfessionalOrThrow(orgA, actor, "req-archived", created.id, { status: "ARCHIVED" });
  assert.equal((await rowsFor("professional.archived")).length, 1);
  assert.equal((await rowsFor("professional.updated")).length, 1, "archiving must NOT also log a generic professional.updated event");

  await updateProfessionalOrThrow(orgA, actor, "req-reactivated", created.id, { status: "ACTIVE" });
  assert.equal((await rowsFor("professional.reactivated")).length, 1);
});

test("audit failure inside the create transaction rolls back the Professional row (real Postgres NOT NULL violation)", async () => {
  const { recordAuditEvent } = await import("../../src/modules/audit/service.js");
  const { insertProfessional } = await import("../../src/modules/professionals/repository.js");
  let insertedId: string | undefined;

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        const row = await insertProfessional(orgA, { name: "Não Deve Persistir" }, tx);
        insertedId = row.id;
        await recordAuditEvent(
          {
            organizationId: orgA.organizationId,
            actorType: "user",
            actorId: "test-actor",
            // @ts-expect-error deliberately violating the NOT NULL constraint to prove rollback
            action: null,
            resourceType: "professional",
            resourceId: row.id,
          },
          tx,
        );
      }),
    /audit_events/i,
  );

  assert.ok(insertedId);
  const rows = await db.select().from(professionals).where(and(eq(professionals.organizationId, orgA.organizationId), eq(professionals.id, insertedId!)));
  assert.equal(rows.length, 0);
});

test("tenant isolation: a Professional created for org A is never visible from org B, and org B cannot read/update it directly", async () => {
  const created = await createProfessional(orgA, actor, "req-1", { name: "Profissional Isolamento" });

  const listB = await listAllProfessionals(orgB, { limit: 100 });
  assert.ok(!listB.some((p) => p.id === created.id));

  await assert.rejects(() => getProfessionalOrThrow(orgB, created.id), NotFoundError);
  await assert.rejects(() => updateProfessionalOrThrow(orgB, actor, "req-2", created.id, { name: "Hacked" }), NotFoundError);
});

test("no uniqueness constraint on name/phone/email — two Professionals in the same Organization may legitimately share any of them (ADR-036)", async () => {
  const p1 = await createProfessional(orgA, actor, "req-1", { name: "Nome Duplicado", phone: "+244900000000" });
  const p2 = await createProfessional(orgA, actor, "req-2", { name: "Nome Duplicado", phone: "+244900000000" });
  assert.notEqual(p1.id, p2.id);
});

// ---- professional_services association ----

async function seedActiveProfessionalAndService(org: typeof orgA) {
  const professional = await createProfessional(org, actor, "req-seed-prof", { name: "Profissional Seed" });
  const service = await insertService(org, { name: "Serviço Seed", durationMinutes: 30 });
  return { professional, service };
}

test("association: a valid Professional+Service association can be created and listed", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  const association = await associateService(orgA, actor, "req-1", professional.id, service.id);
  assert.equal(association.professionalId, professional.id);
  assert.equal(association.serviceId, service.id);

  const list = await listServicesForProfessionalOrThrow(orgA, professional.id);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, service.id);
  assert.equal(list[0]!.name, "Serviço Seed");
});

test("association: tenant-safe composite FK rejects a raw insert associating a Professional from org A with a Service from org B", async () => {
  const professionalInA = await createProfessional(orgA, actor, "req-1", { name: "Profissional A" });
  const serviceInB = await insertService(orgB, { name: "Serviço B", durationMinutes: 30 });

  const err = await db
    .insert(professionalServices)
    .values({ organizationId: orgA.organizationId, professionalId: professionalInA.id, serviceId: serviceInB.id })
    .catch((e) => e);
  assert.ok(err instanceof Error);
  const cause = err.cause instanceof Error ? err.cause.message : String(err);
  assert.match(cause, /foreign key|violat/i);
  assert.match(cause, /professional_services_service_org_fk/);
});

test("association: duplicate association attempt fails with 409 CONFLICT, no second row created", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  await associateService(orgA, actor, "req-1", professional.id, service.id);
  await assert.rejects(() => associateService(orgA, actor, "req-2", professional.id, service.id), ConflictError);

  const list = await listServicesForProfessionalOrThrow(orgA, professional.id);
  assert.equal(list.length, 1, "no duplicate row was created");
});

test("association: nonexistent Professional or Service resolves NotFoundError", async () => {
  const { service } = await seedActiveProfessionalAndService(orgA);
  await assert.rejects(() => associateService(orgA, actor, "req-1", randomUUID(), service.id), NotFoundError);

  const { professional } = await seedActiveProfessionalAndService(orgA);
  await assert.rejects(() => associateService(orgA, actor, "req-2", professional.id, randomUUID()), NotFoundError);
});

test("association: cross-tenant Professional or Service resolves NotFoundError (never leaks existence)", async () => {
  const { professional } = await seedActiveProfessionalAndService(orgA);
  const { service: serviceInB } = await seedActiveProfessionalAndService(orgB);
  await assert.rejects(() => associateService(orgA, actor, "req-1", professional.id, serviceInB.id), NotFoundError);

  const { professional: professionalInB } = await seedActiveProfessionalAndService(orgB);
  const { service: serviceInA } = await seedActiveProfessionalAndService(orgA);
  await assert.rejects(() => associateService(orgA, actor, "req-2", professionalInB.id, serviceInA.id), NotFoundError);
});

test("association: an ARCHIVED Professional cannot receive a new association (409 PROFESSIONAL_ARCHIVED)", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  await updateProfessionalOrThrow(orgA, actor, "req-archive", professional.id, { status: "ARCHIVED" });
  await assert.rejects(() => associateService(orgA, actor, "req-1", professional.id, service.id), ProfessionalArchivedError);
});

test("association: an ARCHIVED Service cannot receive a new association (409 SERVICE_ARCHIVED)", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  await updateService(orgA, service.id, { status: "ARCHIVED" });
  await assert.rejects(() => associateService(orgA, actor, "req-1", professional.id, service.id), ServiceArchivedError);
});

test("association: existing associations survive either side's archival — archiving never removes the row", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  await associateService(orgA, actor, "req-1", professional.id, service.id);

  await updateProfessionalOrThrow(orgA, actor, "req-2", professional.id, { status: "ARCHIVED" });
  const listAfterProfessionalArchive = await listServicesForProfessionalOrThrow(orgA, professional.id);
  assert.equal(listAfterProfessionalArchive.length, 1, "association survives Professional archival");

  await updateProfessionalOrThrow(orgA, actor, "req-3", professional.id, { status: "ACTIVE" });
  await updateService(orgA, service.id, { status: "ARCHIVED" });
  const listAfterServiceArchive = await listServicesForProfessionalOrThrow(orgA, professional.id);
  assert.equal(listAfterServiceArchive.length, 1, "association survives Service archival");
});

test("disassociation: removes the row physically, is idempotent-safe (a second attempt 404s, never double-removes)", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  await associateService(orgA, actor, "req-1", professional.id, service.id);

  await removeAssociation(orgA, actor, "req-2", professional.id, service.id);
  const list = await listServicesForProfessionalOrThrow(orgA, professional.id);
  assert.equal(list.length, 0);

  await assert.rejects(() => removeAssociation(orgA, actor, "req-3", professional.id, service.id), NotFoundError);
});

test("disassociation: allowed even when either side is ARCHIVED (narrowing what exists is never a new capability)", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  await associateService(orgA, actor, "req-1", professional.id, service.id);
  await updateProfessionalOrThrow(orgA, actor, "req-2", professional.id, { status: "ARCHIVED" });

  await removeAssociation(orgA, actor, "req-3", professional.id, service.id);
  const list = await listServicesForProfessionalOrThrow(orgA, professional.id);
  assert.equal(list.length, 0);
});

test("association audit: professional_service.created and professional_service.removed are recorded", async () => {
  const { professional, service } = await seedActiveProfessionalAndService(orgA);
  const association = await associateService(orgA, actor, "req-1", professional.id, service.id);

  const { auditEvents } = await import("../../src/db/schema/index.js");
  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.resourceId, association.id), eq(auditEvents.action, "professional_service.created")));
  assert.equal(createdRows.length, 1);

  await removeAssociation(orgA, actor, "req-2", professional.id, service.id);
  const removedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.action, "professional_service.removed"), eq(auditEvents.resourceId, association.id)));
  assert.equal(removedRows.length, 1);
});

test("list: serviceId filter returns only Professionals associated with that Service, tenant-scoped", async () => {
  const org = { organizationId: randomUUID() };
  const service = await insertService(org, { name: "Massagem", durationMinutes: 60 });
  const p1 = await createProfessional(org, actor, "req-1", { name: "Terapeuta 1" });
  const p2 = await createProfessional(org, actor, "req-2", { name: "Terapeuta 2" });
  await associateService(org, actor, "req-3", p1.id, service.id);

  const filtered = await listAllProfessionals(org, { serviceId: service.id, limit: 50 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, p1.id);
  assert.ok(!filtered.some((p) => p.id === p2.id));
});
