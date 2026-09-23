import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, createService, loadF25Fixtures, registerF25Credentials, startApp } from "./professionalsHelpers.js";

/**
 * F25 brief §38 items relating to the professional_services association
 * (ADR-037) — the genuinely new surface area of this phase, exercised
 * end-to-end over HTTP (unit/integration already cover the repository/
 * service layer directly; this file proves the routes + permission
 * gates + full request/response contract for association management).
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF25Fixtures();

before(async () => {
  ctx = await startApp();
  registerF25Credentials(fixtures);
});
after(() => ctx.close());

test("associate: OWNER associates a Professional with a Service, then GET .../services lists it with duration/price/status/associatedAt", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Associação");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Associação", 45, "25.00");

  const associate = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(associate.status, 201);

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].id, service.id);
  assert.equal(list.data[0].durationMinutes, 45);
  assert.equal(list.data[0].price, "25.00");
  assert.equal(list.data[0].status, "ACTIVE");
  assert.ok(list.data[0].associatedAt);
});

test("associate: duplicate association returns 409 CONFLICT, never a second row", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Duplicado");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Duplicado", 30);

  const first = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(first.status, 201);

  const second = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(second.status, 409);
  assert.equal(second.error.code, "CONFLICT");

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.data.length, 1);
});

test("associate: nonexistent Professional or Service resolves 404", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Sem Serviço");
  const fakeServiceId = "00000000-0000-0000-0000-000000000000";
  const fakeProfessionalId = "00000000-0000-0000-0000-000000000001";
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Sem Profissional", 30);

  const missingService = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${fakeServiceId}`, { token: fixtures.orgA.ownerToken });
  assert.equal(missingService.status, 404);

  const missingProfessional = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${fakeProfessionalId}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(missingProfessional.status, 404);
});

test("associate: ARCHIVED Professional rejects new association with 409 PROFESSIONAL_ARCHIVED", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Arquivado Assoc");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço para Arquivado", 30);
  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });

  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "PROFESSIONAL_ARCHIVED");
});

test("associate: ARCHIVED Service rejects new association with 409 SERVICE_ARCHIVED", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional para Serviço Arquivado");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Arquivado Assoc", 30);
  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });

  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(res.status, 409);
  assert.equal(res.error.code, "SERVICE_ARCHIVED");
});

test("existing associations survive later archival of either side (archival is not retroactive)", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Sobrevive Arquivo");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Sobrevive Arquivo", 30);
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });

  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.data.length, 1, "the association itself is untouched by the service's later archival");
  assert.equal(list.data[0].status, "ARCHIVED", "but the listed service's own status reflects the archival");
});

test("remove: DELETE removes the association (physical delete); a second removal returns 404, proving idempotent-safety not a silent no-op", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Remover Assoc");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Remover Assoc", 30);
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });

  const remove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(remove.status, 200);
  assert.equal(remove.data.removed, true);

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.data.length, 0);

  const secondRemove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(secondRemove.status, 404);
});

test("remove: disassociation is allowed even when the Professional or Service is archived", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Remover Arquivado");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Remover Arquivado", 30);
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  await call(ctx.base, "PATCH", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}`, { token: fixtures.orgA.ownerToken, body: { status: "ARCHIVED" } });

  const remove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(remove.status, 200, "removing an association is always allowed regardless of either side's archived status");
});

test("list professionals with ?serviceId= filter returns only professionals associated with that service, tenant-scoped", async () => {
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Serviço Filtro Lista", 30);
  const associated = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Associado Filtro");
  const unassociated = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Não Associado Filtro");
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${associated.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });

  const filtered = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals?serviceId=${service.id}`, { token: fixtures.orgA.ownerToken });
  assert.equal(filtered.status, 200);
  assert.ok(filtered.data.some((p: { id: string }) => p.id === associated.id));
  assert.ok(!filtered.data.some((p: { id: string }) => p.id === unassociated.id));
});
