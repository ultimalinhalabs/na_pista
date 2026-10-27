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

/** Interface credential (UL 0033): create-only scopes + own-order read. */
test("interface scopes: order.create / customer.create create; either alternative satisfies requireAuthorized", async () => {
  const { requireReadOrOwn } = await import("../../src/middleware/requireAuthorized.js");
  const organizationId = randomUUID();
  const iface = key("NA_PISTA", organizationId, ["catalog.read", "customer.create", "order.create"]);
  const tenant = { organizationId, actorType: "service" as const, scopes: iface.scopes };
  assert.equal(status(run(requireAuthorized("orders.create", ["order.create", "order.write"]), { service: iface, tenant })), 200);
  assert.equal(status(run(requireAuthorized("customers.create", ["customer.create", "customer.write"]), { service: iface, tenant })), 200);
  assert.equal(status(run(requireAuthorized("orders.update", "order.write"), { service: iface, tenant })), 403, "no confirm/cancel/edit");
  assert.equal(status(run(requireAuthorized("orders.read", "order.read"), { service: iface, tenant })), 403, "no listing");
  assert.equal(status(run(requireAuthorized("customers.read", "customer.read"), { service: iface, tenant })), 403, "no reading customers");

  const locals = (r: { locals?: Record<string, unknown> }) => r.locals ?? {};
  const resOwn = { locals: {} as Record<string, unknown> };
  let out: unknown;
  requireReadOrOwn("orders.read", "order.read", "order.create")({ service: iface, tenant } as unknown as Request, resOwn as unknown as Response, (e?: unknown) => (out = e ?? "next"));
  assert.equal(out, "next");
  assert.equal(locals(resOwn).ownResourcesOnly, true, "order.create alone → own orders only");

  const full = key("NA_PISTA", organizationId, ["order.read"]);
  const resFull = { locals: {} as Record<string, unknown> };
  requireReadOrOwn("orders.read", "order.read", "order.create")({ service: full, tenant: { ...tenant, scopes: full.scopes } } as unknown as Request, resFull as unknown as Response, (e?: unknown) => (out = e ?? "next"));
  assert.equal(locals(resFull).ownResourcesOnly, undefined, "order.read → every order");

  const none = key("NA_PISTA", organizationId, ["catalog.read"]);
  requireReadOrOwn("orders.read", "order.read", "order.create")({ service: none, tenant: { ...tenant, scopes: none.scopes } } as unknown as Request, { locals: {} } as unknown as Response, (e?: unknown) => (out = e ?? "next"));
  assert.equal((out as { statusCode?: number }).statusCode, 403);

  const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
  assert.deepEqual(doc.paths["/organizations/{organizationId}/orders"]?.post?.["x-na-pista-scope"], ["order.create", "order.write"]);
  assert.deepEqual(doc.paths["/organizations/{organizationId}/orders/{orderId}"]?.get?.["x-na-pista-scope"], ["order.read", "order.create"]);
  assert.deepEqual(doc.paths["/organizations/{organizationId}/customers"]?.post?.["x-na-pista-scope"], ["customer.create", "customer.write"]);
});
