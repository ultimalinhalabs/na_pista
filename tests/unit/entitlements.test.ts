import assert from "node:assert/strict";
import test from "node:test";
import { enabledModules, entitlementsRefusal, interpretCapability, interpretModule, readLimit, type RawEntitlementsResponse } from "../../src/platform/entitlements.js";

const app = { application: { key: "NA_PISTA", name: "Na Pista" } };
function resp(entitlements: { key: string; value: unknown }[], subscription: RawEntitlementsResponse["subscription"] = { id: "sub_1", status: "active", planKey: "BUSINESS" }): RawEntitlementsResponse {
  return { ...app, subscription, entitlements };
}

test("catalog.enabled true -> enabled", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: true }]), "catalog.enabled");
  assert.equal(d.enabled, true);
});

test("catalog.enabled false -> disabled (fail closed)", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: false }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-false");
});

test("catalog.enabled absent -> disabled (never assume enabled)", () => {
  const d = interpretCapability(resp([{ key: "other.key", value: true }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-missing");
});

test("invalid shape -> disabled", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: "yes" }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-invalid");
});

test("no subscription -> disabled", () => {
  const d = interpretCapability(resp([], null), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "no-subscription");
});

test("null response -> disabled", () => {
  assert.equal(interpretCapability(null, "catalog.enabled").enabled, false);
});

test("readLimit: NaN/Infinity rejected", () => {
  assert.equal(readLimit(resp([{ key: "products.max", value: NaN }]), "products.max").hasLimit, false);
  assert.equal(readLimit(resp([{ key: "products.max", value: Infinity }]), "products.max").hasLimit, false);
});

test("readLimit: numeric value usable", () => {
  const l = readLimit(resp([{ key: "products.max", value: 1000 }]), "products.max");
  assert.equal(l.hasLimit, true);
  assert.equal(l.max, 1000);
});

test("entitlementsRefusal: no current commercial authority in UL is 403 ENTITLEMENT_REQUIRED; anything else stays a 503", () => {
  for (const code of ["CREDENTIAL_NOT_AUTHORIZED", "APPLICATION_ACCESS_REQUIRED"]) {
    const e = entitlementsRefusal({ status: 403, error: { code, message: "x" } }, "org-1") as { statusCode?: number; code?: string };
    assert.equal(e.code, "ENTITLEMENT_REQUIRED", code);
    assert.equal(e.statusCode, 403);
  }
  for (const res of [{ status: 403, error: { code: "FORBIDDEN", message: "x" } }, { status: 500 }, { status: 401, error: { code: "CREDENTIAL_REVOKED", message: "x" } }, { status: 404 }]) {
    assert.equal((entitlementsRefusal(res, "org-1") as { code?: string }).code, "UPSTREAM_UNAVAILABLE", JSON.stringify(res));
  }
});

// ── Audit 2026-10-20 / UL migration 0031: one entitlement per module ─────────────────────────────────────

const ALL = [
  { key: "catalog.enabled", value: true },
  { key: "orders.enabled", value: true },
  { key: "customers.enabled", value: true },
  { key: "services.enabled", value: true },
];

test("catalog.enabled no longer unlocks the other modules once the plan carries their keys", () => {
  const catalogOnly = resp([
    { key: "catalog.enabled", value: true },
    { key: "orders.enabled", value: false },
    { key: "customers.enabled", value: false },
    { key: "services.enabled", value: false },
  ]);
  assert.deepEqual(enabledModules(catalogOnly), { catalog: true, orders: false, customers: false, services: false });
  assert.equal(interpretModule(catalogOnly, "services").reason, "entitlement-false");
});

test("services without catalog is possible (and catalog without services)", () => {
  const servicesOnly = resp([
    { key: "catalog.enabled", value: false },
    { key: "orders.enabled", value: false },
    { key: "customers.enabled", value: true },
    { key: "services.enabled", value: true },
  ]);
  assert.deepEqual(enabledModules(servicesOnly), { catalog: false, orders: false, customers: true, services: true });
});

test("dependencies are enforced here too: orders needs catalog, services needs customers", () => {
  const ordersNoCatalog = resp([{ key: "catalog.enabled", value: false }, { key: "orders.enabled", value: true }, { key: "customers.enabled", value: true }, { key: "services.enabled", value: true }]);
  assert.equal(interpretModule(ordersNoCatalog, "orders").enabled, false);
  assert.equal(interpretModule(ordersNoCatalog, "orders").reason, "dependency-missing");
  const servicesNoCustomers = resp([{ key: "catalog.enabled", value: true }, { key: "orders.enabled", value: true }, { key: "customers.enabled", value: false }, { key: "services.enabled", value: true }]);
  assert.equal(interpretModule(servicesNoCustomers, "services").reason, "dependency-missing");
});

test("transition: an ABSENT module key falls back to catalog.enabled (plans not yet migrated keep today's access); an explicit false is honoured", () => {
  const legacy = resp([{ key: "catalog.enabled", value: true }, { key: "products.max", value: 100 }]);
  assert.deepEqual(enabledModules(legacy), { catalog: true, orders: true, customers: true, services: true });
  assert.equal(interpretModule(legacy, "services").legacyFallback, true);
  const legacyOff = resp([{ key: "catalog.enabled", value: false }]);
  assert.deepEqual(enabledModules(legacyOff), { catalog: false, orders: false, customers: false, services: false });
  const explicitOff = resp([{ key: "catalog.enabled", value: true }, { key: "services.enabled", value: false }]);
  assert.equal(interpretModule(explicitOff, "services").enabled, false);
  assert.equal(interpretModule(explicitOff, "services").legacyFallback, false);
});

test("module keys: wrong type, no subscription, or UL access not effective -> disabled", () => {
  assert.equal(interpretModule(resp([...ALL.filter((e) => e.key !== "orders.enabled"), { key: "orders.enabled", value: "true" }]), "orders").reason, "entitlement-invalid");
  assert.deepEqual(enabledModules(resp(ALL, null)), { catalog: false, orders: false, customers: false, services: false });
  assert.deepEqual(enabledModules(null), { catalog: false, orders: false, customers: false, services: false });
  const suspended: RawEntitlementsResponse = { ...resp(ALL), access: { effective: false, reason: "ORGANIZATION_SUSPENDED" } };
  assert.deepEqual(enabledModules(suspended), { catalog: false, orders: false, customers: false, services: false });
  assert.equal(readLimit({ ...resp([{ key: "products.max", value: 10 }]), access: { effective: false, reason: "GRANT_NOT_EFFECTIVE" } }, "products.max").hasLimit, false);
  assert.equal(interpretModule({ ...resp(ALL), access: { effective: true, reason: null } }, "services").enabled, true);
});
