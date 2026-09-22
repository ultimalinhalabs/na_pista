import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { customers } from "../../src/db/schema/index.js";
import { getCustomer, insertCustomer, listCustomers, updateCustomer } from "../../src/modules/customers/repository.js";
import { recordAuditEvent } from "../../src/modules/audit/service.js";

/** F21 brief §19 "Integration tests", real PostgreSQL, no HTTP, no Platform. */
const orgA = { organizationId: randomUUID() };
const orgB = { organizationId: randomUUID() };

after(() => queryClient.end());

test("creation, update, and archive persist correctly", async () => {
  const created = await insertCustomer(orgA, { name: "Ana Silva", email: "ana@example.com", phone: "+244923456789" });
  assert.equal(created.status, "ACTIVE");

  const updated = await updateCustomer(orgA, created.id, { notes: "Cliente preferencial" });
  assert.equal(updated?.notes, "Cliente preferencial");
  assert.equal(updated?.name, "Ana Silva", "unrelated fields survive a partial update");

  const archived = await updateCustomer(orgA, created.id, { status: "ARCHIVED" });
  assert.equal(archived?.status, "ARCHIVED");

  const stillReadable = await getCustomer(orgA, created.id);
  assert.equal(stillReadable?.id, created.id, "archived customers remain retrievable by id (F21 brief §16)");
});

test("a customer created for org A is never visible from org B's tenant-scoped query", async () => {
  const customer = await insertCustomer(orgA, { name: "Isolation Probe" });
  const listB = await listCustomers(orgB, { limit: 50 });
  assert.ok(!listB.some((c) => c.id === customer.id));
  assert.equal(await getCustomer(orgB, customer.id), undefined);
});

test("search (q) matches name, email, or phone, tenant-scoped", async () => {
  const org = { organizationId: randomUUID() };
  await insertCustomer(org, { name: "Beatriz Fernandes", email: "bea@example.com", phone: "+244911000000" });
  await insertCustomer(org, { name: "Carlos Mendes", email: "carlos@example.com", phone: "+244922000000" });

  const byName = await listCustomers(org, { q: "beatriz", limit: 50 });
  assert.equal(byName.length, 1);
  assert.equal(byName[0]!.name, "Beatriz Fernandes");

  const byEmail = await listCustomers(org, { q: "carlos@example.com", limit: 50 });
  assert.equal(byEmail.length, 1);
  assert.equal(byEmail[0]!.name, "Carlos Mendes");

  const byPhone = await listCustomers(org, { q: "911000000", limit: 50 });
  assert.equal(byPhone.length, 1);
  assert.equal(byPhone[0]!.name, "Beatriz Fernandes");

  const noMatch = await listCustomers(org, { q: "nonexistent-term-xyz", limit: 50 });
  assert.equal(noMatch.length, 0);
});

test("status filter excludes archived customers when status=ACTIVE is requested", async () => {
  const org = { organizationId: randomUUID() };
  const active = await insertCustomer(org, { name: "Active Customer" });
  const toArchive = await insertCustomer(org, { name: "Will Be Archived" });
  await updateCustomer(org, toArchive.id, { status: "ARCHIVED" });

  const activeOnly = await listCustomers(org, { status: "ACTIVE", limit: 50 });
  assert.ok(activeOnly.some((c) => c.id === active.id));
  assert.ok(!activeOnly.some((c) => c.id === toArchive.id));

  const archivedOnly = await listCustomers(org, { status: "ARCHIVED", limit: 50 });
  assert.ok(archivedOnly.some((c) => c.id === toArchive.id));
});

test("audit failure inside the same transaction rolls back the customer row (ADR-023/ADR-026, F21 brief §13/§20)", async () => {
  const org = { organizationId: randomUUID() };
  let insertedId: string | undefined;

  await assert.rejects(
    () =>
      db.transaction(async (tx) => {
        const row = await insertCustomer(org, { name: "Should Never Persist" }, tx);
        insertedId = row.id;
        // Force a real Postgres NOT NULL violation on the audit insert —
        // `action` is `text(...).notNull()` — proving REAL transactional
        // rollback, not a mocked assertion.
        await recordAuditEvent(
          {
            organizationId: org.organizationId,
            actorType: "user",
            actorId: "test-actor",
            // @ts-expect-error deliberately violating the NOT NULL constraint to prove rollback
            action: null,
            resourceType: "customer",
            resourceId: row.id,
          },
          tx,
        );
      }),
    /audit_events/i, // drizzle-orm's own error message names the failing query; the real cause (verified separately) is a Postgres NOT NULL violation on `action`
  );

  assert.ok(insertedId, "the insert must have run inside the transaction before the audit failure");
  const rows = await db.select().from(customers).where(and(eq(customers.organizationId, org.organizationId), eq(customers.id, insertedId!)));
  assert.equal(rows.length, 0, "the customer row must not exist after the transaction rolled back");
});
