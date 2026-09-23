import assert from "node:assert/strict";
import test from "node:test";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import { timezoneSchema, updateOrganizationSettingsSchema } from "../../src/modules/organizationSettings/schemas.js";

/** ADR-040: IANA timezone identifiers only — never a raw UTC offset. */

test("timezoneSchema: accepts real IANA identifiers", () => {
  // "UTC" is deliberately NOT included — confirmed empirically that Node's
  // own Intl.supportedValuesOf("timeZone") does not list it (no assumption).
  for (const valid of ["Africa/Luanda", "America/Sao_Paulo", "Europe/Lisbon", "Asia/Tokyo"]) {
    assert.equal(timezoneSchema.safeParse(valid).success, true, `expected ${valid} to be a valid IANA timezone`);
  }
});

test("timezoneSchema: rejects a raw UTC offset (ADR-040: never a UTC-offset identity)", () => {
  assert.equal(timezoneSchema.safeParse("+01:00").success, false);
  assert.equal(timezoneSchema.safeParse("UTC+1").success, false);
  assert.equal(timezoneSchema.safeParse("GMT-3").success, false);
});

test("timezoneSchema: rejects a nonexistent/malformed identifier", () => {
  assert.equal(timezoneSchema.safeParse("Not/A_Real_Zone").success, false);
  assert.equal(timezoneSchema.safeParse("").success, false);
  assert.equal(timezoneSchema.safeParse("africa/luanda").success, false, "IANA identifiers are case-sensitive");
});

test("updateOrganizationSettingsSchema: rejects protected/unknown fields", () => {
  assert.equal(updateOrganizationSettingsSchema.safeParse({ timezone: "Africa/Luanda", organizationId: "x" }).success, false);
  assert.equal(updateOrganizationSettingsSchema.safeParse({ timezone: "Africa/Luanda", createdAt: "2020-01-01" }).success, false);
});

test("updateOrganizationSettingsSchema: rejects a missing timezone", () => {
  assert.equal(updateOrganizationSettingsSchema.safeParse({}).success, false);
});

/** authorization (F26 brief §25) — reuses scheduling.read/update, no dedicated organization_settings.* permission (docs/f26-report.md §14). */
test("permission mapping: organization settings reuse scheduling.read/scheduling.update — STAFF read-only, MANAGER/ADMIN/OWNER can update", () => {
  assert.equal(roleHasPermission("STAFF", "scheduling.read"), true);
  assert.equal(roleHasPermission("STAFF", "scheduling.update"), false);
  for (const role of ["OWNER", "ADMIN", "MANAGER"]) {
    assert.equal(roleHasPermission(role, "scheduling.read"), true);
    assert.equal(roleHasPermission(role, "scheduling.update"), true);
  }
});
