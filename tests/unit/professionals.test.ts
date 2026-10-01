import assert from "node:assert/strict";
import test from "node:test";
import { createProfessionalSchema, listProfessionalsQuerySchema, updateProfessionalSchema } from "../../src/modules/professionals/schemas.js";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import { pageRequest } from "../../src/shared/listing.js";

/** F25 brief §36: valid create. */
test("createProfessionalSchema: a valid professional (name only) is accepted", () => {
  const result = createProfessionalSchema.safeParse({ name: "João Silva" });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.name, "João Silva");
    assert.equal(result.data.phone, undefined);
    assert.equal(result.data.email, undefined);
  }
});

test("createProfessionalSchema: accepts name + description + phone + email together", () => {
  const result = createProfessionalSchema.safeParse({
    name: "Ana Costa",
    description: "Especialista em coloração",
    phone: "+244923456789",
    email: "ana.costa@example.com",
  });
  assert.equal(result.success, true);
});

/** invalid name */
test("createProfessionalSchema: rejects an empty name, whitespace-only name, and a missing name", () => {
  assert.equal(createProfessionalSchema.safeParse({ name: "" }).success, false);
  assert.equal(createProfessionalSchema.safeParse({ name: "   " }).success, false);
  assert.equal(createProfessionalSchema.safeParse({}).success, false);
});

test("createProfessionalSchema: trims name and description", () => {
  const result = createProfessionalSchema.safeParse({ name: "  Carlos Mendes  ", description: "  Barbeiro sénior  " });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.name, "Carlos Mendes");
    assert.equal(result.data.description, "Barbeiro sénior");
  }
});

/** invalid phone/email conforme validators — F25 brief §36, reusing Customer's exact validators (ADR-036) */
test("createProfessionalSchema: phone accepts an Angolan-shaped number, and other international shapes too (never Angola-only)", () => {
  assert.equal(createProfessionalSchema.safeParse({ name: "x", phone: "+244923456789" }).success, true);
  assert.equal(createProfessionalSchema.safeParse({ name: "x", phone: "+1 (555) 123-4567" }).success, true);
});

test("createProfessionalSchema: rejects a malformed phone", () => {
  const result = createProfessionalSchema.safeParse({ name: "x", phone: "not-a-phone" });
  assert.equal(result.success, false);
});

test("createProfessionalSchema: rejects a malformed email", () => {
  const result = createProfessionalSchema.safeParse({ name: "x", email: "not-an-email" });
  assert.equal(result.success, false);
});

test("createProfessionalSchema: rejects protected/unknown fields (id/organizationId/status/createdAt/updatedAt/userId/serviceId/customerId/appointmentId/scheduleId)", () => {
  const base = { name: "x" };
  for (const field of ["id", "organizationId", "status", "createdAt", "updatedAt", "userId", "serviceId", "customerId", "appointmentId", "scheduleId"]) {
    const result = createProfessionalSchema.safeParse({ ...base, [field]: "anything" });
    assert.equal(result.success, false, `expected ${field} to be rejected`);
  }
});

test("createProfessionalSchema: rejects calendar/availability/booking-shaped fields — Professional is not Scheduling/Appointment (ADR-036/038)", () => {
  const base = { name: "x" };
  for (const field of ["workingHours", "availability", "vacation", "calendar", "bookingStatus", "commission", "rating"]) {
    const result = createProfessionalSchema.safeParse({ ...base, [field]: "anything" });
    assert.equal(result.success, false, `expected ${field} to be rejected`);
  }
});

/** update */
test("updateProfessionalSchema: allows a partial update of any single field", () => {
  assert.equal(updateProfessionalSchema.safeParse({ name: "Novo Nome" }).success, true);
  assert.equal(updateProfessionalSchema.safeParse({ phone: "+244923456789" }).success, true);
  assert.equal(updateProfessionalSchema.safeParse({ email: "novo@example.com" }).success, true);
  assert.equal(updateProfessionalSchema.safeParse({ description: null }).success, true);
});

test("updateProfessionalSchema: phone/email can be explicitly cleared to null", () => {
  const result = updateProfessionalSchema.safeParse({ phone: null, email: null });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.phone, null);
    assert.equal(result.data.email, null);
  }
});

/** archive / reactivate via PATCH status — F25 brief §8/§13, matching F24's established Service pattern */
test("updateProfessionalSchema: status accepts ACTIVE and ARCHIVED, rejects anything else (no ON_LEAVE/BUSY/AVAILABLE/VACATION/OFFLINE)", () => {
  assert.equal(updateProfessionalSchema.safeParse({ status: "ARCHIVED" }).success, true);
  assert.equal(updateProfessionalSchema.safeParse({ status: "ACTIVE" }).success, true);
  for (const invalid of ["ON_LEAVE", "BUSY", "AVAILABLE", "VACATION", "OFFLINE"]) {
    assert.equal(updateProfessionalSchema.safeParse({ status: invalid }).success, false, `expected ${invalid} to be rejected`);
  }
});

test("updateProfessionalSchema: rejects id/organizationId/createdAt being changed", () => {
  assert.equal(updateProfessionalSchema.safeParse({ id: "x" }).success, false);
  assert.equal(updateProfessionalSchema.safeParse({ organizationId: "x" }).success, false);
  assert.equal(updateProfessionalSchema.safeParse({ createdAt: "2020-01-01" }).success, false);
});

test("listProfessionalsQuerySchema: status/q/serviceId/limit bounds", () => {
  assert.equal(listProfessionalsQuerySchema.safeParse({ status: "ACTIVE" }).success, true);
  assert.equal(listProfessionalsQuerySchema.safeParse({ status: "DELETED" }).success, false);
  assert.equal(listProfessionalsQuerySchema.safeParse({ serviceId: "11111111-1111-4111-8111-111111111111" }).success, true);
  assert.equal(listProfessionalsQuerySchema.safeParse({ serviceId: "not-a-uuid" }).success, false);
  assert.equal(listProfessionalsQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(listProfessionalsQuerySchema.safeParse({ limit: 101 }).success, false);
  const defaults = listProfessionalsQuerySchema.safeParse({});
  assert.equal(defaults.success, true);
  // ADR-051: the default page size (still 50) is applied by pageRequest(), not by the schema.
  if (defaults.success) assert.equal(pageRequest(defaults.data, 50).pageSize, 50);
});

/** authorization (F25 brief §16, ADR-036 §8) */
test("permission mapping: STAFF can read professionals but has no mutation permission at all", () => {
  assert.equal(roleHasPermission("STAFF", "professionals.read"), true);
  assert.equal(roleHasPermission("STAFF", "professionals.create"), false);
  assert.equal(roleHasPermission("STAFF", "professionals.update"), false);
});

test("permission mapping: MANAGER can create and update professionals (including archive/reactivate and association management)", () => {
  assert.equal(roleHasPermission("MANAGER", "professionals.create"), true);
  assert.equal(roleHasPermission("MANAGER", "professionals.update"), true);
});

test("permission mapping: OWNER/ADMIN have full professional management", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    assert.equal(roleHasPermission(role, "professionals.read"), true);
    assert.equal(roleHasPermission(role, "professionals.create"), true);
    assert.equal(roleHasPermission(role, "professionals.update"), true);
  }
});

test("permission mapping: professionals.delete does not exist for any role, and there is no separate professional_services.manage permission (F25 brief §16, ADR-036 §8)", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER", "STAFF"]) {
    assert.equal(roleHasPermission(role, "professionals.delete"), false);
    assert.equal(roleHasPermission(role, "professional_services.manage"), false);
  }
});
