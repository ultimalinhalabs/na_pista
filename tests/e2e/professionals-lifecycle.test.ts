import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, loadF25Fixtures, registerF25Credentials, startApp } from "./professionalsHelpers.js";

/** F25 brief §38 E2E items 7-12. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF25Fixtures();

before(async () => {
  ctx = await startApp();
  registerF25Credentials(fixtures);
});
after(() => ctx.close());

test("7: authenticated OWNER creates a Professional — server accepts only the ADR-036 fields, status defaults to ACTIVE", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "João Silva", description: "Barbeiro sénior", phone: "+244923456789", email: "joao@example.com" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgA.id);
  assert.equal(res.data.name, "João Silva");
  assert.equal(res.data.phone, "+244923456789");
  assert.equal(res.data.email, "joao@example.com");
  assert.equal(res.data.status, "ACTIVE");
});

test("create: a Professional can be created with only a name", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken, body: { name: "Ana Costa" } });
  assert.equal(res.status, 201);
  assert.equal(res.data.phone, null);
  assert.equal(res.data.email, null);
});

test("create: rejects invalid input — missing name, malformed phone, malformed email", async () => {
  const missingName = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken, body: {} });
  assert.equal(missingName.status, 400);

  const badPhone = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken, body: { name: "x", phone: "not-a-phone" } });
  assert.equal(badPhone.status, 400);

  const badEmail = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken, body: { name: "x", email: "not-an-email" } });
  assert.equal(badEmail.status, 400);
});

test("create: client-supplied id/organizationId/status/userId/serviceId/customerId are rejected, never silently accepted", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals`, {
    token: fixtures.orgA.ownerToken,
    body: {
      name: "x",
      id: "11111111-1111-1111-1111-111111111111",
      organizationId: "22222222-2222-2222-2222-222222222222",
      status: "ARCHIVED",
      userId: "x",
      serviceId: "x",
      customerId: "x",
    },
  });
  assert.equal(res.status, 400);
});

test("8/9: GET list and detail", async () => {
  const created = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Listagem");

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((p: { id: string }) => p.id === created.id));

  const detail = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.id, created.id);
});

test("list: status filter and name search (q) work, tenant-scoped", async () => {
  await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Terapeuta Relaxante Única");

  const found = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals?q=Relaxante+Única`, { token: fixtures.orgA.ownerToken });
  assert.equal(found.status, 200);
  assert.ok(found.data.some((p: { name: string }) => p.name === "Terapeuta Relaxante Única"));

  const activeOnly = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals?status=ACTIVE`, { token: fixtures.orgA.ownerToken });
  assert.ok(activeOnly.data.every((p: { status: string }) => p.status === "ACTIVE"));
});

test("10: PATCH updates name/description/phone/email", async () => {
  const created = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional a Editar");
  const updated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Profissional Editado", description: "Nova descrição", phone: "+244911000000", email: "editado@example.com" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.name, "Profissional Editado");
  assert.equal(updated.data.phone, "+244911000000");
});

test("11/12: archive (PATCH status=ARCHIVED) then reactivate (PATCH status=ACTIVE) — no DELETE, no dedicated lifecycle endpoints", async () => {
  const created = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Ciclo de Vida");

  const archived = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.status, "ARCHIVED");

  const stillReadable = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(stillReadable.data.status, "ARCHIVED");

  const activeList = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals?status=ACTIVE`, { token: fixtures.orgA.ownerToken });
  assert.ok(!activeList.data.some((p: { id: string }) => p.id === created.id));

  const reactivated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${created.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ACTIVE" } });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.data.status, "ACTIVE");

  // No DELETE endpoint exists (ADR-036 §19).
  const deleteAttempt = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals/${created.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  });
  assert.equal(deleteAttempt.status, 404, "no route is registered for DELETE on this path");
});

test("request reference (X-Request-ID) is preserved on a Professional write", async () => {
  const suppliedId = "f25-e2e-probe-987";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": suppliedId },
    body: JSON.stringify({ name: "Profissional Request ID" }),
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);
});
