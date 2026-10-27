import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { serviceScopeFor } from "../../src/authorization/serviceScopes.js";
import { buildOpenApiDocument } from "../../src/contract/openapi.js";
import { requireAuthorized, serviceHasScope } from "../../src/middleware/requireAuthorized.js";
import { requireTenantContext } from "../../src/tenancy/tenantContext.js";

/**
 * Credentials audit 2026-10-23 (no network): a service credential must be a NA_PISTA key of the path's organization
 * holding the operation's scope. Personal data (customers, orders, appointments) has its own scopes; `catalog.*` is
 * accepted there only for NA_PISTA keys and only while the legacy mode is `accept`.
 */
function run(middleware: (req: Request, res: Response, next: NextFunction) => void, req: Partial<Request>): unknown {
  let result: unknown = "not-called";
  middleware(req as Request, {} as Response, (error?: unknown) => {
    result = error ?? "next";
  });
  return result;
}
const key = (application: string, organizationId: string, scopes: string[]) => ({ apiKeyId: randomUUID(), application, organizationId, scopes, credentialClass: "ORGANIZATION" });
const status = (r: unknown) => (r === "next" ? 200 : (r as { statusCode?: number }).statusCode);

test("application: QUALE_A_DICA and FOI keys are refused on Na Pista even with catalog scopes; a NA_PISTA key passes", () => {
  const organizationId = randomUUID();
  for (const application of ["QUALE_A_DICA", "FOI", "MICHA_EXPRESS"]) {
    assert.equal(status(run(requireTenantContext(), { params: { organizationId }, service: key(application, organizationId, ["catalog.read", "catalog.write"]) })), 403, application);
  }
  assert.equal(status(run(requireTenantContext(), { params: { organizationId }, service: key("NA_PISTA", organizationId, ["catalog.read"]) })), 200);
});

test("organization isolation is unchanged: a NA_PISTA key of org A on org B's path → 403", () => {
  assert.equal(status(run(requireTenantContext(), { params: { organizationId: randomUUID() }, service: key("NA_PISTA", randomUUID(), ["customer.read"]) })), 403);
});

test("scopes per resource: customers/orders/appointments use their own scopes; everything else (and free slots) stays on catalog", () => {
  assert.equal(serviceScopeFor("customers.read", "read"), "customer.read");
  assert.equal(serviceScopeFor("customers.delete", "write"), "customer.write");
  assert.equal(serviceScopeFor("orders.update", "write"), "order.write");
  assert.equal(serviceScopeFor("appointments.read", "read"), "appointment.read");
  assert.equal(serviceScopeFor("products.read", "read"), "catalog.read");
  assert.equal(serviceScopeFor("inventory.update", "write"), "catalog.write");
  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const scopeOf = (path: string, method: string) => doc.paths[path]?.[method]?.["x-na-pista-scope"];
  assert.equal(scopeOf("/organizations/{organizationId}/customers", "get"), "customer.read");
  assert.equal(scopeOf("/organizations/{organizationId}/orders/{orderId}/confirm", "post"), "order.write");
  assert.equal(scopeOf("/organizations/{organizationId}/appointments", "post"), "appointment.write");
  assert.equal(scopeOf("/organizations/{organizationId}/professionals/{professionalId}/bookable-slots", "get"), "catalog.read");
  assert.equal(scopeOf("/organizations/{organizationId}/products", "get"), "catalog.read");
});

test("read never grants write; one resource's scope never grants another's", () => {
  const s = { apiKeyId: randomUUID(), scopes: ["customer.read", "order.read"] };
  assert.equal(serviceHasScope(s, "customer.read", "refuse"), true);
  assert.equal(serviceHasScope(s, "customer.write", "accept"), false, "read → no write, legacy mode or not");
  assert.equal(serviceHasScope(s, "appointment.read", "accept"), false, "order.read is not appointment.read");
  assert.equal(serviceHasScope({ apiKeyId: randomUUID(), scopes: ["order.read"] }, "customer.read", "accept"), false);
  assert.equal(serviceHasScope({ apiKeyId: randomUUID(), scopes: ["customer.read"] }, "catalog.read", "accept"), false, "no reverse fallback");
});

test("legacy catalog.* on personal-data routes: accepted in `accept` mode, refused in `refuse` mode; never for writes from a read scope", () => {
  const legacy = { apiKeyId: randomUUID(), scopes: ["catalog.read"] };
  assert.equal(serviceHasScope(legacy, "customer.read", "accept"), true);
  assert.equal(serviceHasScope(legacy, "customer.read", "refuse"), false);
  assert.equal(serviceHasScope(legacy, "customer.write", "accept"), false, "catalog.read never stands in for a write");
  assert.equal(serviceHasScope({ apiKeyId: randomUUID(), scopes: ["catalog.write"] }, "order.write", "accept"), true);
  assert.equal(serviceHasScope({ apiKeyId: randomUUID(), scopes: ["catalog.write"] }, "order.read", "accept"), false, "catalog.write never stands in for a read");
});

test("requireAuthorized over a NA_PISTA tenant: new scope 200, missing scope 403; a human keeps using role permissions", () => {
  const organizationId = randomUUID();
  const svc = key("NA_PISTA", organizationId, ["order.read"]);
  const tenant = { organizationId, actorType: "service" as const, scopes: svc.scopes };
  assert.equal(status(run(requireAuthorized("orders.read", "order.read"), { service: svc, tenant })), 200);
  assert.equal(status(run(requireAuthorized("customers.read", "customer.read"), { service: svc, tenant })), 403);
  assert.equal(status(run(requireAuthorized("customers.read", "customer.read"), { tenant: { organizationId, actorType: "human", roleKey: "OWNER", userId: "u" } })), 200);
});
