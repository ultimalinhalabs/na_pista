import assert from "node:assert/strict";
import test from "node:test";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import {
  MAX_AVAILABILITY_RANGE_DAYS,
  availabilityQuerySchema,
  createExceptionSchema,
  localTimeSchema,
  replaceScheduleSchema,
} from "../../src/modules/scheduling/schemas.js";

test("localTimeSchema: accepts valid HH:mm, rejects malformed shapes", () => {
  for (const valid of ["00:00", "08:00", "23:59", "09:30"]) {
    assert.equal(localTimeSchema.safeParse(valid).success, true, `expected ${valid} to be valid`);
  }
  for (const invalid of ["24:00", "23:60", "8:00", "08:0", "08:00:00", "noon", "", "25:99", "-01:00"]) {
    assert.equal(localTimeSchema.safeParse(invalid).success, false, `expected ${invalid} to be rejected`);
  }
});

test("replaceScheduleSchema: accepts an empty rule array (closed every day, ADR-039 D33)", () => {
  assert.equal(replaceScheduleSchema.safeParse({ rules: [] }).success, true);
});

test("replaceScheduleSchema: accepts multiple intervals per day", () => {
  const result = replaceScheduleSchema.safeParse({
    rules: [
      { dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00" },
      { dayOfWeek: 1, startLocalTime: "13:00", endLocalTime: "17:00" },
    ],
  });
  assert.equal(result.success, true);
});

test("replaceScheduleSchema: rejects dayOfWeek outside 0-6", () => {
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: 7, startLocalTime: "08:00", endLocalTime: "12:00" }] }).success, false);
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: -1, startLocalTime: "08:00", endLocalTime: "12:00" }] }).success, false);
});

test("replaceScheduleSchema: rejects a non-integer/NaN/numeric-string dayOfWeek", () => {
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: 1.5, startLocalTime: "08:00", endLocalTime: "12:00" }] }).success, false);
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: NaN, startLocalTime: "08:00", endLocalTime: "12:00" }] }).success, false);
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: "1", startLocalTime: "08:00", endLocalTime: "12:00" }] }).success, false);
});

test("replaceScheduleSchema: rejects a zero-length interval (start === end)", () => {
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "08:00" }] }).success, false);
});

test("replaceScheduleSchema: rejects a reversed interval (end before start) — overnight intervals are NOT supported in F26 (ADR-039 D3)", () => {
  assert.equal(replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: 1, startLocalTime: "22:00", endLocalTime: "02:00" }] }).success, false);
});

test("replaceScheduleSchema: rejects protected/unknown fields on a rule", () => {
  assert.equal(
    replaceScheduleSchema.safeParse({ rules: [{ dayOfWeek: 1, startLocalTime: "08:00", endLocalTime: "12:00", id: "x", organizationId: "x" }] }).success,
    false,
  );
});

test("createExceptionSchema: accepts an interval exception", () => {
  assert.equal(createExceptionSchema.safeParse({ date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "14:00" }).success, true);
});

test("createExceptionSchema: accepts a closed-marker exception (both times absent)", () => {
  assert.equal(createExceptionSchema.safeParse({ date: "2026-12-25" }).success, true);
});

test("createExceptionSchema: rejects providing only ONE of startLocalTime/endLocalTime (ambiguous half-shape)", () => {
  assert.equal(createExceptionSchema.safeParse({ date: "2026-09-28", startLocalTime: "09:00" }).success, false);
  assert.equal(createExceptionSchema.safeParse({ date: "2026-09-28", endLocalTime: "14:00" }).success, false);
});

test("createExceptionSchema: rejects a reversed/zero-length exception interval", () => {
  assert.equal(createExceptionSchema.safeParse({ date: "2026-09-28", startLocalTime: "14:00", endLocalTime: "09:00" }).success, false);
  assert.equal(createExceptionSchema.safeParse({ date: "2026-09-28", startLocalTime: "09:00", endLocalTime: "09:00" }).success, false);
});

test("createExceptionSchema: rejects a malformed date", () => {
  assert.equal(createExceptionSchema.safeParse({ date: "28-09-2026" }).success, false);
  assert.equal(createExceptionSchema.safeParse({ date: "2026-9-28" }).success, false);
});

test("availabilityQuerySchema: accepts a valid bounded range, with and without serviceId", () => {
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-09-28", to: "2026-09-30" }).success, true);
  assert.equal(
    availabilityQuerySchema.safeParse({ from: "2026-09-28", to: "2026-09-30", serviceId: "11111111-1111-4111-8111-111111111111" }).success,
    true,
  );
});

test("availabilityQuerySchema: rejects a malformed serviceId", () => {
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-09-28", to: "2026-09-30", serviceId: "not-a-uuid" }).success, false);
});

test("availabilityQuerySchema: rejects to before from", () => {
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-09-30", to: "2026-09-28" }).success, false);
});

test("availabilityQuerySchema: accepts to === from (a single-day query)", () => {
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-09-28", to: "2026-09-28" }).success, true);
});

test(`availabilityQuerySchema: rejects a range exceeding ${MAX_AVAILABILITY_RANGE_DAYS} days (query-horizon protection, ADR-039/040 D34)`, () => {
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-01-01", to: "2030-01-01" }).success, false, "an unbounded multi-year range must be rejected");
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success, false, "a full year exceeds the 92-day horizon");
});

test("availabilityQuerySchema: rejects missing from/to and malformed date strings", () => {
  assert.equal(availabilityQuerySchema.safeParse({ to: "2026-09-30" }).success, false);
  assert.equal(availabilityQuerySchema.safeParse({ from: "2026-09-28" }).success, false);
  assert.equal(availabilityQuerySchema.safeParse({ from: "not-a-date", to: "2026-09-30" }).success, false);
});

/** authorization (F26 brief §19, ADR-039) */
test("permission mapping: STAFF can read scheduling but has no mutation permission at all", () => {
  assert.equal(roleHasPermission("STAFF", "scheduling.read"), true);
  assert.equal(roleHasPermission("STAFF", "scheduling.create"), false);
  assert.equal(roleHasPermission("STAFF", "scheduling.update"), false);
});

test("permission mapping: MANAGER can create and update scheduling (matching Professional's own shape)", () => {
  assert.equal(roleHasPermission("MANAGER", "scheduling.create"), true);
  assert.equal(roleHasPermission("MANAGER", "scheduling.update"), true);
});

test("permission mapping: OWNER/ADMIN have full scheduling management", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    assert.equal(roleHasPermission(role, "scheduling.read"), true);
    assert.equal(roleHasPermission(role, "scheduling.create"), true);
    assert.equal(roleHasPermission(role, "scheduling.update"), true);
  }
});

test("permission mapping: scheduling.delete does not exist for any role (ADR-039 D32: removal is gated by scheduling.update, no separate lifecycle tier)", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER", "STAFF"]) {
    assert.equal(roleHasPermission(role, "scheduling.delete"), false);
  }
});
