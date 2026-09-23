import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { services } from "../../src/db/schema/index.js";
import { createService, getServiceOrThrow, listAllServices, updateServiceOrThrow } from "../../src/modules/services/service.js";
import { NotFoundError } from "../../src/shared/errors.js";

/** F24 brief §20 "Integration tests", real PostgreSQL, no HTTP, no Platform. */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };
const actor = { type: "user" as const, id: "test-actor" };

after(() => queryClient.end());

test("migration: the services table exists with the expected shape (a real query against it succeeds)", async () => {
  const rows = await db.select().from(services).limit(1);
  assert.ok(Array.isArray(rows));
});

test("create + read: a Service persists with the exact ADR-033 fields, status defaults to ACTIVE", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Corte Masculino", description: "Corte tradicional", durationMinutes: 45, price: "3500.00" });
  assert.equal(created.name, "Corte Masculino");
  assert.equal(created.description, "Corte tradicional");
  assert.equal(created.durationMinutes, 45);
  assert.equal(created.price, "3500.00");
  assert.equal(created.status, "ACTIVE");
  assert.equal(created.organizationId, orgA.organizationId);

  const read = await getServiceOrThrow(orgA, created.id);
  assert.equal(read.id, created.id);
});

test("create: a Service can exist without a price (unpriced, ADR-034)", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Serviço Sem Preço", durationMinutes: 30 });
  assert.equal(created.price, null);
});

test("create: durationMinutes persists as a real integer, never a string/decimal", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Massagem", durationMinutes: 90 });
  assert.equal(typeof created.durationMinutes, "number");
  assert.equal(created.durationMinutes, 90);
});

test("update: name/description/durationMinutes/price can all be changed, updatedAt advances", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Corte", durationMinutes: 30, price: "1000.00" });
  await new Promise((r) => setTimeout(r, 5));
  const updated = await updateServiceOrThrow(orgA, actor, "req-2", created.id, { name: "Corte Premium", description: "Novo", durationMinutes: 60, price: "2000.00" });
  assert.equal(updated.name, "Corte Premium");
  assert.equal(updated.description, "Novo");
  assert.equal(updated.durationMinutes, 60);
  assert.equal(updated.price, "2000.00");
  assert.ok(updated.updatedAt.getTime() > created.updatedAt.getTime());
});

test("update: price can be cleared back to null explicitly", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Corte", durationMinutes: 30, price: "1000.00" });
  const updated = await updateServiceOrThrow(orgA, actor, "req-2", created.id, { price: null });
  assert.equal(updated.price, null);
});

test("archive (ACTIVE -> ARCHIVED via PATCH status): the Service remains readable afterward, excluded from the ACTIVE list", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Serviço a Arquivar", durationMinutes: 30 });
  const archived = await updateServiceOrThrow(orgA, actor, "req-2", created.id, { status: "ARCHIVED" });
  assert.equal(archived.status, "ARCHIVED");

  const stillReadable = await getServiceOrThrow(orgA, created.id);
  assert.equal(stillReadable.status, "ARCHIVED");

  const activeList = await listAllServices(orgA, { status: "ACTIVE", limit: 100 });
  assert.ok(!activeList.some((s) => s.id === created.id));
  const archivedList = await listAllServices(orgA, { status: "ARCHIVED", limit: 100 });
  assert.ok(archivedList.some((s) => s.id === created.id));
});

test("reactivate (ARCHIVED -> ACTIVE via PATCH status): the Service becomes selectable again", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Serviço a Reactivar", durationMinutes: 30 });
  await updateServiceOrThrow(orgA, actor, "req-2", created.id, { status: "ARCHIVED" });
  const reactivated = await updateServiceOrThrow(orgA, actor, "req-3", created.id, { status: "ACTIVE" });
  assert.equal(reactivated.status, "ACTIVE");

  const activeList = await listAllServices(orgA, { status: "ACTIVE", limit: 100 });
  assert.ok(activeList.some((s) => s.id === created.id));
});

test("audit: create/update/archive/reactivate each record the correct, distinct audit action", async () => {
  const created = await createService(orgA, actor, "req-created", { name: "Serviço Audit", durationMinutes: 30 });

  const { auditEvents } = await import("../../src/db/schema/index.js");
  const rowsFor = async (action: string) =>
    db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, orgA.organizationId), eq(auditEvents.resourceId, created.id), eq(auditEvents.action, action)));

  assert.equal((await rowsFor("service.created")).length, 1);

  await updateServiceOrThrow(orgA, actor, "req-updated", created.id, { name: "Serviço Audit Renomeado" });
  assert.equal((await rowsFor("service.updated")).length, 1);

  await updateServiceOrThrow(orgA, actor, "req-archived", created.id, { status: "ARCHIVED" });
  assert.equal((await rowsFor("service.archived")).length, 1);
  assert.equal((await rowsFor("service.updated")).length, 1, "archiving must NOT also log a generic service.updated event");

  await updateServiceOrThrow(orgA, actor, "req-reactivated", created.id, { status: "ACTIVE" });
  assert.equal((await rowsFor("service.reactivated")).length, 1);
});

test("audit failure inside the create transaction rolls back the Service row (real Postgres NOT NULL violation, not a mock)", async () => {
  const { recordAuditEvent } = await import("../../src/modules/audit/service.js");
  let insertedId: string | undefined;

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        const { insertService } = await import("../../src/modules/services/repository.js");
        const row = await insertService(orgA, { name: "Não Deve Persistir", durationMinutes: 30 }, tx);
        insertedId = row.id;
        await recordAuditEvent(
          {
            organizationId: orgA.organizationId,
            actorType: "user",
            actorId: "test-actor",
            // @ts-expect-error deliberately violating the NOT NULL constraint to prove rollback
            action: null,
            resourceType: "service",
            resourceId: row.id,
          },
          tx,
        );
      }),
    /audit_events/i,
  );

  assert.ok(insertedId);
  const rows = await db.select().from(services).where(and(eq(services.organizationId, orgA.organizationId), eq(services.id, insertedId!)));
  assert.equal(rows.length, 0, "the Service row must not exist after the transaction rolled back");
});

test("tenant isolation: a Service created for org A is never visible from org B, and org B cannot read/update it directly", async () => {
  const created = await createService(orgA, actor, "req-1", { name: "Serviço Isolamento", durationMinutes: 30 });

  const listB = await listAllServices(orgB, { limit: 100 });
  assert.ok(!listB.some((s) => s.id === created.id));

  await assert.rejects(() => getServiceOrThrow(orgB, created.id), NotFoundError);
  await assert.rejects(() => updateServiceOrThrow(orgB, actor, "req-2", created.id, { name: "Hacked" }), NotFoundError);
  await assert.rejects(() => updateServiceOrThrow(orgB, actor, "req-3", created.id, { status: "ARCHIVED" }), NotFoundError);
});

test("no uniqueness constraint on name — two Services in the same Organization may legitimately share a name (ADR-033 §6)", async () => {
  const s1 = await createService(orgA, actor, "req-1", { name: "Corte Duplicado", durationMinutes: 30 });
  const s2 = await createService(orgA, actor, "req-2", { name: "Corte Duplicado", durationMinutes: 45 });
  assert.notEqual(s1.id, s2.id);
});

test("q (name search) is ILIKE, tenant-scoped, matching the exact convention Products/Customers already use", async () => {
  const org = { organizationId: randomUUID() };
  await createService(org, actor, "req-1", { name: "Massagem Relaxante", durationMinutes: 60 });
  await createService(org, actor, "req-2", { name: "Corte de Cabelo", durationMinutes: 30 });

  const found = await listAllServices(org, { q: "massagem", limit: 50 });
  assert.equal(found.length, 1);
  assert.equal(found[0]!.name, "Massagem Relaxante");
});
