import assert from "node:assert/strict";
import test from "node:test";
import { createServiceSchema, listServicesQuerySchema, updateServiceSchema } from "../../src/modules/services/schemas.js";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import { pageRequest } from "../../src/shared/listing.js";

/** F24 brief §19: create valid service. */
test("createServiceSchema: a valid service (name + durationMinutes) is accepted, price defaults to undefined", () => {
  const result = createServiceSchema.safeParse({ name: "Corte Masculino", durationMinutes: 45 });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.name, "Corte Masculino");
    assert.equal(result.data.durationMinutes, 45);
    assert.equal(result.data.price, undefined);
  }
});

/** invalid name / missing name */
test("createServiceSchema: rejects an empty name and a missing name", () => {
  assert.equal(createServiceSchema.safeParse({ name: "", durationMinutes: 30 }).success, false);
  assert.equal(createServiceSchema.safeParse({ durationMinutes: 30 }).success, false);
});

test("createServiceSchema: trims the name and description", () => {
  const result = createServiceSchema.safeParse({ name: "  Corte  ", description: "  Corte tradicional  ", durationMinutes: 30 });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.name, "Corte");
    assert.equal(result.data.description, "Corte tradicional");
  }
});

/** F24 brief §3: durationMinutes must be a plain JSON integer, never a decimal string, never fractional. */
test("createServiceSchema: durationMinutes is required", () => {
  const result = createServiceSchema.safeParse({ name: "Corte" });
  assert.equal(result.success, false);
});

test("createServiceSchema: durationMinutes rejects zero and negative values", () => {
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 0 }).success, false);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: -30 }).success, false);
});

test("createServiceSchema: durationMinutes rejects a decimal number", () => {
  const result = createServiceSchema.safeParse({ name: "Corte", durationMinutes: 45.5 });
  assert.equal(result.success, false);
});

test("createServiceSchema: durationMinutes rejects a numeric STRING — must be a plain JSON number, not a decimal-string like price/quantity", () => {
  const result = createServiceSchema.safeParse({ name: "Corte", durationMinutes: "60" });
  assert.equal(result.success, false);
});

test("createServiceSchema: durationMinutes rejects NaN and Infinity", () => {
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: NaN }).success, false);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: Infinity }).success, false);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: -Infinity }).success, false);
});

test("createServiceSchema: accepts any positive integer minute count, not constrained to 15/30/60 multiples (ADR-034 §9)", () => {
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 1 }).success, true);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 17 }).success, true);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 90 }).success, true);
});

/** F24 brief §4/ADR-034: price reuses Product's exact money validator. */
test("createServiceSchema: price accepts a number or decimal string, normalizes to 2 decimals", () => {
  const r1 = createServiceSchema.safeParse({ name: "Corte", durationMinutes: 30, price: 2500 });
  assert.equal(r1.success, true);
  if (r1.success) assert.equal(r1.data.price, "2500.00");

  const r2 = createServiceSchema.safeParse({ name: "Corte", durationMinutes: 30, price: "2500.5" });
  assert.equal(r2.success, true);
  if (r2.success) assert.equal(r2.data.price, "2500.50");
});

test("createServiceSchema: price rejects negative/NaN/Infinity", () => {
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 30, price: -1 }).success, false);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 30, price: NaN }).success, false);
  assert.equal(createServiceSchema.safeParse({ name: "Corte", durationMinutes: 30, price: Infinity }).success, false);
});

test("createServiceSchema: price = null is invalid on CREATE (a Service simply omits price to stay unpriced; null is only a valid PATCH operation to CLEAR an existing price)", () => {
  const result = createServiceSchema.safeParse({ name: "Corte", durationMinutes: 30, price: null });
  assert.equal(result.success, false);
});

test("createServiceSchema: price = 0 is explicitly valid (a deliberately free service, ADR-034)", () => {
  const result = createServiceSchema.safeParse({ name: "Consulta Grátis", durationMinutes: 15, price: 0 });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.price, "0.00");
});

test("createServiceSchema: rejects protected/unknown fields (id/organizationId/status/createdAt/updatedAt/currency)", () => {
  const base = { name: "Corte", durationMinutes: 30 };
  for (const field of ["id", "organizationId", "status", "createdAt", "updatedAt", "currency"]) {
    const result = createServiceSchema.safeParse({ ...base, [field]: "anything" });
    assert.equal(result.success, false, `expected ${field} to be rejected`);
  }
});

test("createServiceSchema: rejects categoryId/professionalId/customerId/quantity — Service is not a Product clone and has no scheduling fields (F24 brief §2)", () => {
  const base = { name: "Corte", durationMinutes: 30 };
  for (const field of ["categoryId", "professionalId", "customerId", "appointmentId", "scheduleId", "quantity", "barcode"]) {
    const result = createServiceSchema.safeParse({ ...base, [field]: "anything" });
    assert.equal(result.success, false, `expected ${field} to be rejected`);
  }
});

/** update */
test("updateServiceSchema: allows a partial update of any single field", () => {
  assert.equal(updateServiceSchema.safeParse({ name: "Novo Nome" }).success, true);
  assert.equal(updateServiceSchema.safeParse({ durationMinutes: 60 }).success, true);
  assert.equal(updateServiceSchema.safeParse({ price: "3000.00" }).success, true);
  assert.equal(updateServiceSchema.safeParse({ description: null }).success, true);
});

test("updateServiceSchema: price can be explicitly cleared back to null (\"not yet priced\", distinct from 0)", () => {
  const result = updateServiceSchema.safeParse({ price: null });
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.price, null);
});

/** archive / reactivate via PATCH status — F24 brief §5/§13 */
test("updateServiceSchema: status accepts ACTIVE and ARCHIVED, rejects anything else", () => {
  assert.equal(updateServiceSchema.safeParse({ status: "ARCHIVED" }).success, true);
  assert.equal(updateServiceSchema.safeParse({ status: "ACTIVE" }).success, true);
  assert.equal(updateServiceSchema.safeParse({ status: "DRAFT" }).success, false);
  assert.equal(updateServiceSchema.safeParse({ status: "DELETED" }).success, false);
});

test("updateServiceSchema: rejects id/organizationId/createdAt being changed", () => {
  assert.equal(updateServiceSchema.safeParse({ id: "x" }).success, false);
  assert.equal(updateServiceSchema.safeParse({ organizationId: "x" }).success, false);
  assert.equal(updateServiceSchema.safeParse({ createdAt: "2020-01-01" }).success, false);
});

test("listServicesQuerySchema: status/q/limit bounds", () => {
  assert.equal(listServicesQuerySchema.safeParse({ status: "ACTIVE" }).success, true);
  assert.equal(listServicesQuerySchema.safeParse({ status: "DELETED" }).success, false);
  assert.equal(listServicesQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(listServicesQuerySchema.safeParse({ limit: 101 }).success, false);
  const defaults = listServicesQuerySchema.safeParse({});
  assert.equal(defaults.success, true);
  // ADR-051: the default page size (still 50) is applied by pageRequest(), not by the schema.
  if (defaults.success) assert.equal(pageRequest(defaults.data, 50).pageSize, 50);
});

/** authorization (F24 brief §6/§19) */
test("permission mapping: STAFF can read services but has no mutation permission at all", () => {
  assert.equal(roleHasPermission("STAFF", "services.read"), true);
  assert.equal(roleHasPermission("STAFF", "services.create"), false);
  assert.equal(roleHasPermission("STAFF", "services.update"), false);
});

test("permission mapping: MANAGER can create and update services (including archive/reactivate via update)", () => {
  assert.equal(roleHasPermission("MANAGER", "services.create"), true);
  assert.equal(roleHasPermission("MANAGER", "services.update"), true);
});

test("permission mapping: OWNER/ADMIN have full service management", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    assert.equal(roleHasPermission(role, "services.read"), true);
    assert.equal(roleHasPermission(role, "services.create"), true);
    assert.equal(roleHasPermission(role, "services.update"), true);
  }
});

test("permission mapping: services.delete does not exist for any role (F24 brief §6/§15)", () => {
  for (const role of ["OWNER", "ADMIN", "MANAGER", "STAFF"]) {
    assert.equal(roleHasPermission(role, "services.delete"), false);
  }
});
