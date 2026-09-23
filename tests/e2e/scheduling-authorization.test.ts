import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, loadF26Fixtures, registerF26Credentials, setTimezone, startApp } from "./schedulingHelpers.js";

/**
 * F26 brief §31 "Authorization" — OWNER/ADMIN/MANAGER/STAFF. Revoked/
 * expired service credential AND revoked membership behavior are
 * deliberately NOT re-proven here — both are exhaustively covered by
 * F19's own spike and reused unchanged by every phase since (F20-F25).
 */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF26Fixtures();

before(async () => {
  ctx = await startApp();
  registerF26Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken);
});
after(() => ctx.close());

test("STAFF can read schedule/exceptions/availability but is denied from mutating any of them", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional STAFF Agenda");

  const readSchedule = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, { token: fixtures.staffA.token });
  assert.equal(readSchedule.status, 200);

  const putSchedule = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.staffA.token,
    body: { rules: [] },
  });
  assert.equal(putSchedule.status, 403);
  assert.equal(putSchedule.error.code, "FORBIDDEN");

  const createException = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.staffA.token,
    body: { date: "2026-12-25" },
  });
  assert.equal(createException.status, 403);

  const readAvailability = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28`, {
    token: fixtures.staffA.token,
  });
  assert.equal(readAvailability.status, 200);
});

test("MANAGER can create/update the weekly schedule and manage exceptions (matches Professional's own OWNER/ADMIN/MANAGER-identical shape)", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional MANAGER Agenda");

  const put = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.managerA.token,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }] },
  });
  assert.equal(put.status, 200);

  const createException = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.managerA.token,
    body: { date: "2026-12-25" },
  });
  assert.equal(createException.status, 201);

  const removeException = await call(
    ctx.base,
    "DELETE",
    `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions/${createException.data.id}`,
    { token: fixtures.managerA.token },
  );
  assert.equal(removeException.status, 200, "no OWNER/ADMIN-only tier for Scheduling mutations");
});

test("a service credential with sufficient scope (catalog.write) can mutate a schedule on its own organization", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Service Credential Agenda");
  const res = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.apiKeys.integrationA.secret,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }] },
  });
  assert.equal(res.status, 200);
});

test("a service credential with insufficient scope (usage.write/event.publish only) is blocked from writing", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Insufficient Scope Agenda");
  const res = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.apiKeys.platformFacingA.secret,
    body: { rules: [] },
  });
  assert.equal(res.status, 403);
  assert.equal(res.error.code, "FORBIDDEN");
});

test("no Authorization header -> 401 (unauthenticated user)", async () => {
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${fixtures.orgA.id}/schedule`);
  assert.equal(res.status, 401);
});
