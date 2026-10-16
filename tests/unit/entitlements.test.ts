import assert from "node:assert/strict";
import test from "node:test";
import { entitlementsRefusal, interpretCapability, readLimit, type RawEntitlementsResponse } from "../../src/platform/entitlements.js";

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
