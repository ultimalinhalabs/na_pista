import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerSchema, updateCustomerSchema, listCustomersQuerySchema } from "../../src/modules/customers/schemas.js";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import * as customerRepo from "../../src/modules/customers/repository.js";
import { pageRequest } from "../../src/shared/listing.js";

/** F21 brief §19 "customer validation". */
test("createCustomerSchema: name required, everything else optional", () => {
  assert.equal(createCustomerSchema.safeParse({}).success, false);
  assert.equal(createCustomerSchema.safeParse({ name: "" }).success, false);
  assert.equal(createCustomerSchema.safeParse({ name: "João Manuel" }).success, true);
});

test("createCustomerSchema: valid email accepted, invalid rejected", () => {
  assert.equal(createCustomerSchema.safeParse({ name: "x", email: "not-an-email" }).success, false);
  assert.equal(createCustomerSchema.safeParse({ name: "x", email: "joao@example.com" }).success, true);
});

test("createCustomerSchema: Angolan-shaped phone accepted, and other international shapes too (never Angola-only)", () => {
  assert.equal(createCustomerSchema.safeParse({ name: "x", phone: "+244923456789" }).success, true);
  assert.equal(createCustomerSchema.safeParse({ name: "x", phone: "+1 (555) 123-4567" }).success, true);
  assert.equal(createCustomerSchema.safeParse({ name: "x", phone: "abc" }).success, false);
});

test("createCustomerSchema: status/id/organizationId/createdAt/updatedAt are never accepted on create", () => {
  const result = createCustomerSchema.safeParse({ name: "x", status: "ARCHIVED" });
  assert.equal(result.success, false);
  assert.equal(createCustomerSchema.safeParse({ name: "x", organizationId: "y" }).success, false);
  assert.equal(createCustomerSchema.safeParse({ name: "x", id: "y" }).success, false);
});

test("updateCustomerSchema: allows explicitly clearing email/phone/notes to null", () => {
  const result = updateCustomerSchema.safeParse({ email: null, phone: null, notes: null });
  assert.equal(result.success, true);
});

test("updateCustomerSchema: status transition to ACTIVE/ARCHIVED accepted, anything else rejected", () => {
  assert.equal(updateCustomerSchema.safeParse({ status: "ARCHIVED" }).success, true);
  assert.equal(updateCustomerSchema.safeParse({ status: "ACTIVE" }).success, true);
  assert.equal(updateCustomerSchema.safeParse({ status: "DELETED" }).success, false);
});

test("listCustomersQuerySchema: search term and limit bounds", () => {
  assert.equal(listCustomersQuerySchema.safeParse({}).success, true);
  // ADR-051: the default page size (still 50) is applied by pageRequest(), not by the schema.
  assert.equal(pageRequest(listCustomersQuerySchema.parse({}), 50).pageSize, 50);
  assert.equal(listCustomersQuerySchema.safeParse({ limit: "101" }).success, false);
  assert.equal(listCustomersQuerySchema.safeParse({ q: "joão" }).success, true);
});

/** F21 brief §19 "permission mapping". */
test("permission mapping: STAFF can read customers but not write/delete them", () => {
  assert.equal(roleHasPermission("STAFF", "customers.read"), true);
  assert.equal(roleHasPermission("STAFF", "customers.create"), false);
  assert.equal(roleHasPermission("STAFF", "customers.delete"), false);
});

test("permission mapping: MANAGER can create/update customers but not delete (archive) them", () => {
  assert.equal(roleHasPermission("MANAGER", "customers.create"), true);
  assert.equal(roleHasPermission("MANAGER", "customers.update"), true);
  assert.equal(roleHasPermission("MANAGER", "customers.delete"), false);
});

test("permission mapping: OWNER and ADMIN can do everything, including archive", () => {
  for (const role of ["OWNER", "ADMIN"]) {
    for (const perm of ["customers.read", "customers.create", "customers.update", "customers.delete"]) {
      assert.equal(roleHasPermission(role, perm), true, `${role} should have ${perm}`);
    }
  }
});

/** F21 brief §19 "repository tenant scoping". */
test("customer repository refuses to run without a TenantContext", async () => {
  // @ts-expect-error deliberately calling without a tenant to prove the guard
  await assert.rejects(() => customerRepo.insertCustomer(undefined, { name: "x" }), /TenantContext/);
  // @ts-expect-error deliberately calling with null to prove the guard
  await assert.rejects(() => customerRepo.listCustomers(null, { limit: 10 }), /TenantContext/);
  // @ts-expect-error deliberately calling with an empty object to prove the guard
  await assert.rejects(() => customerRepo.getCustomer({}, "id"), /TenantContext/);
  await assert.rejects(() => customerRepo.updateCustomer({ organizationId: "" }, "id", {}), /TenantContext/);
});
