import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createService, loadF24Fixtures, registerF24Credentials, startApp } from "./servicesHelpers.js";

/** F24 brief §21 E2E items 1/7/8/9/10/11/12. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF24Fixtures();

before(async () => {
  ctx = await startApp();
  registerF24Credentials(fixtures);
});
after(() => ctx.close());

test("1/7: authenticated OWNER creates a Service — server accepts only the ADR-033 fields, status defaults to ACTIVE", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Corte Masculino", description: "Corte tradicional", durationMinutes: 45, price: "3500.00" },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.organizationId, fixtures.orgA.id);
  assert.equal(res.data.name, "Corte Masculino");
  assert.equal(res.data.durationMinutes, 45);
  assert.equal(res.data.price, "3500.00");
  assert.equal(res.data.status, "ACTIVE");
});

test("create: a Service can be created without a price (unpriced)", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Serviço Sem Preço", durationMinutes: 30 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.price, null);
});

test("create: rejects invalid input — missing name, zero/negative/decimal duration, a numeric-string duration", async () => {
  const missingName = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken, body: { durationMinutes: 30 } });
  assert.equal(missingName.status, 400);

  const zeroDuration = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken, body: { name: "x", durationMinutes: 0 } });
  assert.equal(zeroDuration.status, 400);

  const decimalDuration = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken, body: { name: "x", durationMinutes: 45.5 } });
  assert.equal(decimalDuration.status, 400);

  const stringDuration = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken, body: { name: "x", durationMinutes: "60" } });
  assert.equal(stringDuration.status, 400);
});

test("create: client-supplied id/organizationId/status/currency/categoryId/professionalId are rejected, never silently accepted", async () => {
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/services`, {
    token: fixtures.orgA.ownerToken,
    body: {
      name: "x",
      durationMinutes: 30,
      id: "11111111-1111-1111-1111-111111111111",
      organizationId: "22222222-2222-2222-2222-222222222222",
      status: "ARCHIVED",
      currency: "USD",
      categoryId: "x",
      professionalId: "x",
    },
  });
  assert.equal(res.status, 400);
});

test("8/9: GET list and detail", async () => {
  const created = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Listagem", 30);

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.status, 200);
  assert.ok(list.data.some((s: { id: string }) => s.id === created.id));

  const detail = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.id, created.id);
});

test("list: status filter and name search (q) work, tenant-scoped", async () => {
  await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Massagem Relaxante Única", 60);

  const found = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services?q=Relaxante+Única`, { token: fixtures.orgA.ownerToken });
  assert.equal(found.status, 200);
  assert.ok(found.data.some((s: { name: string }) => s.name === "Massagem Relaxante Única"));

  const activeOnly = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services?status=ACTIVE`, { token: fixtures.orgA.ownerToken });
  assert.ok(activeOnly.data.every((s: { status: string }) => s.status === "ACTIVE"));
});

test("10: PATCH updates name/description/durationMinutes/price", async () => {
  const created = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço a Editar", 30, "1000.00");
  const updated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${created.id}`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Serviço Editado", description: "Nova descrição", durationMinutes: 60, price: "2000.00" },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.name, "Serviço Editado");
  assert.equal(updated.data.durationMinutes, 60);
  assert.equal(updated.data.price, "2000.00");
});

test("PATCH: price can be explicitly cleared back to null", async () => {
  const created = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Preço Nulo", 30, "500.00");
  const updated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.orgA.ownerToken, body: { price: null } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.price, null);
});

test("11/12: archive (PATCH status=ARCHIVED) then reactivate (PATCH status=ACTIVE) — no DELETE, no dedicated lifecycle endpoints", async () => {
  const created = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Ciclo de Vida", 30);

  const archived = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });
  assert.equal(archived.status, 200);
  assert.equal(archived.data.status, "ARCHIVED");

  const stillReadable = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(stillReadable.status, 200);
  assert.equal(stillReadable.data.status, "ARCHIVED");

  const activeList = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/services?status=ACTIVE`, { token: fixtures.orgA.ownerToken });
  assert.ok(!activeList.data.some((s: { id: string }) => s.id === created.id));

  const reactivated = await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${created.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ACTIVE" } });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.data.status, "ACTIVE");

  // No DELETE endpoint exists (F24A/ADR-033 §19).
  const deleteAttempt = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/services/${created.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  });
  assert.equal(deleteAttempt.status, 404, "no route is registered for DELETE on this path");
});

test("request reference (X-Request-ID) is preserved on a Service write", async () => {
  const suppliedId = "f24-e2e-probe-654";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/services`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": suppliedId },
    body: JSON.stringify({ name: "Serviço Request ID", durationMinutes: 30 }),
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);
});
