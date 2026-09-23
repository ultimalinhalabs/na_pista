import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { auditEvents } from "../../src/db/schema/index.js";
import { call, createProfessional, loadF26Fixtures, registerF26Credentials, setTimezone, startApp } from "./schedulingHelpers.js";

/** F26 brief §31/§21/§22 — real audit rows and real Platform usage. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF26Fixtures();

before(async () => {
  ctx = await startApp();
  registerF26Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken);
});
after(() => ctx.close());

test("PUT schedule produces a schedule.updated audit row, with a real requestId", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Audit Agenda E2E");
  const requestId = `f26-audit-probe-${Date.now()}`;
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    method: "PUT",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }] }),
  });
  assert.equal(res.status, 200);

  const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, professional.id), eq(auditEvents.action, "schedule.updated")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.requestId, requestId);
});

test("creating and removing an exception produces schedule.exception.created and schedule.exception.removed audit rows", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Audit Excecao E2E");
  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.orgA.ownerToken,
    body: { date: "2026-12-25" },
  });
  assert.equal(created.status, 201);

  const createdRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, created.data.id), eq(auditEvents.action, "schedule.exception.created")));
  assert.equal(createdRows.length, 1);

  await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions/${created.data.id}`, { token: fixtures.orgA.ownerToken });
  const removedRows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, created.data.id), eq(auditEvents.action, "schedule.exception.removed")));
  assert.equal(removedRows.length, 1);
});

test("computing availability (a read) does NOT produce any audit row (F26 brief §21: no noisy audit for read-only computation)", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Audit Disponibilidade E2E");
  // `createProfessional` itself legitimately produces a `professional.created`
  // row (F25) sharing this same resourceId — count rows BEFORE the read to
  // isolate what the availability GET itself adds, rather than asserting
  // zero rows total for the professional.
  const before = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, professional.id)));

  await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28`, { token: fixtures.orgA.ownerToken });

  const after = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.resourceId, professional.id)));
  assert.equal(after.length, before.length, "the availability GET added no new audit row");
});

test("updating organization settings (timezone) produces an organization_settings.updated audit row", async () => {
  const requestId = `f26-settings-audit-${Date.now()}`;
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/settings`, {
    method: "PUT",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": requestId },
    body: JSON.stringify({ timezone: "Europe/Lisbon" }),
  });
  assert.equal(res.status, 200);

  const rows = await db.select().from(auditEvents).where(and(eq(auditEvents.organizationId, fixtures.orgA.id), eq(auditEvents.action, "organization_settings.updated"), eq(auditEvents.requestId, requestId)));
  assert.equal(rows.length, 1);

  // restore Africa/Luanda for subsequent tests in the file
  await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/settings`, { token: fixtures.orgA.ownerToken, body: { timezone: "Africa/Luanda" } });
});

test("a schedule write records real Platform usage (api_requests meter)", async () => {
  const before1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before1.data?.quantity ?? 0;

  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Usage E2E");
  await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }] },
  });

  let afterQty = beforeQty;
  for (let i = 0; i < 10 && afterQty <= beforeQty; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const after1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
      headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
    }).then((r) => r.json());
    afterQty = after1.data?.quantity ?? beforeQty;
  }
  assert.ok(afterQty > beforeQty, `expected api_requests usage to increase from ${beforeQty}, got ${afterQty}`);
});
