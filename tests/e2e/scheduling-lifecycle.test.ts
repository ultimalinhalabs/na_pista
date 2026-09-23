import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProfessional, createService, loadF26Fixtures, registerF26Credentials, setTimezone, startApp } from "./schedulingHelpers.js";

/** F26 brief §31 "Scheduling"/"Service" E2E items — weekly schedule, exceptions, and availability computation, over real HTTP. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF26Fixtures();

before(async () => {
  ctx = await startApp();
  registerF26Credentials(fixtures);
  await setTimezone(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken);
});
after(() => ctx.close());

test("create weekly schedule: PUT persists rules, GET reflects them", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Agenda E2E");
  const put = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }, { dayOfWeek: 1, startLocalTime: "13:00", endLocalTime: "17:00" }] },
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.length, 2);

  const get = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, { token: fixtures.orgA.ownerToken });
  assert.equal(get.status, 200);
  assert.equal(get.data.length, 2);
});

test("update weekly schedule: a second PUT atomically replaces the first (ADR-039 D10)", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Agenda Replace");
  await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }] },
  });
  const secondPut = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 3, startLocalTime: "09:00", endLocalTime: "10:00" }] },
  });
  assert.equal(secondPut.status, 200);
  assert.equal(secondPut.data.length, 1);
  assert.equal(secondPut.data[0].dayOfWeek, 3);
});

test("schedule mutation is rejected as a whole when overlapping intervals are submitted — nothing partial is saved", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Overlap E2E");
  await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" }] },
  });
  const rejected = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: {
      rules: [
        { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
        { dayOfWeek: 1, startLocalTime: "11:00", endLocalTime: "14:00" },
      ],
    },
  });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.error.code, "VALIDATION_ERROR");

  const get = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, { token: fixtures.orgA.ownerToken });
  assert.equal(get.data.length, 1, "the previous schedule is untouched");
});

test("schedule mutation rejects an overnight interval (22:00-02:00) — deterministic 400, never silently transformed (ADR-039 D3)", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Overnight E2E");
  const res = await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "22:00", endLocalTime: "02:00" }] },
  });
  assert.equal(res.status, 400);
});

test("create exception: an interval exception can be created; retrieve exceptions; replace with a closed-marker on a different date", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Excecao E2E");
  const create = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.orgA.ownerToken,
    body: { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" },
  });
  assert.equal(create.status, 201);

  const closed = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.orgA.ownerToken,
    body: { date: "2026-12-25" },
  });
  assert.equal(closed.status, 201);
  assert.equal(closed.data.startLocalTime, null);

  const list = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, { token: fixtures.orgA.ownerToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.length, 2);
});

test("delete exception: removes it (physical delete); a second removal returns 404, proving idempotent-safety", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Remover Excecao E2E");
  const created = await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.orgA.ownerToken,
    body: { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" },
  });

  const remove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(remove.status, 200);
  assert.equal(remove.data.removed, true);

  const secondRemove = await call(ctx.base, "DELETE", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions/${created.data.id}`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(secondRemove.status, 404);
});

test("compute availability: reflects weekly schedule, then an exception fully replacing it for that date — the F26 brief's own worked example", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Disponibilidade E2E");
  await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: {
      rules: [
        { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
        { dayOfWeek: 1, startLocalTime: "13:00", endLocalTime: "17:00" },
      ],
    },
  });

  const beforeException = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(beforeException.status, 200);
  assert.deepEqual(beforeException.data.days[0].workingIntervals, [
    { start: "08:00", end: "12:00" },
    { start: "13:00", end: "17:00" },
  ]);

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule/exceptions`, {
    token: fixtures.orgA.ownerToken,
    body: { date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" },
  });

  const afterException = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.deepEqual(afterException.data.days[0].workingIntervals, [{ start: "09:00", end: "14:00" }], "the exception COMPLETELY replaces the weekly rule, never a merge");
});

test("compute availability with serviceId: returns serviceStartTimes derived from Service.durationMinutes", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Disponibilidade Servico E2E");
  const service = await createService(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Corte E2E", 60);
  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/services/${service.id}`, { token: fixtures.orgA.ownerToken });
  await call(ctx.base, "PUT", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    token: fixtures.orgA.ownerToken,
    body: { rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "09:00" }] },
  });

  const res = await call(
    ctx.base,
    "GET",
    `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/availability?from=2026-09-28&to=2026-09-28&serviceId=${service.id}`,
    { token: fixtures.orgA.ownerToken },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.days[0].serviceStartTimes, ["08:00"]);
});

test("compute availability: an unbounded/excessive date range is rejected (query-horizon protection, ADR-039/040 D34)", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Range E2E");
  const res = await call(ctx.base, "GET", `/organizations/${fixtures.orgA.id}/professionals/${professional.id}/availability?from=2020-01-01&to=2030-01-01`, {
    token: fixtures.orgA.ownerToken,
  });
  assert.equal(res.status, 400);
});

test("compute availability: request reference (X-Request-ID) is preserved on a schedule write", async () => {
  const professional = await createProfessional(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Profissional Request ID E2E");
  const suppliedId = "f26-e2e-probe-123";
  const res = await fetch(`${ctx.base}/organizations/${fixtures.orgA.id}/professionals/${professional.id}/schedule`, {
    method: "PUT",
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}`, "content-type": "application/json", "x-request-id": suppliedId },
    body: JSON.stringify({ rules: [] }),
  });
  assert.equal(res.headers.get("x-request-id"), suppliedId);
});
