import assert from "node:assert/strict";
import test from "node:test";
import { interpretCapability, readLimit, type RawEntitlementsResponse } from "../../src/platform/entitlements.js";

/**
 * F19 §12: entitlement semantics — pure, no network. Every case the brief
 * lists explicitly, fail-closed by default.
 */

const app = { application: { key: "NA_PISTA", name: "Na Pista" } };

function resp(entitlements: { key: string; value: unknown }[], subscription: RawEntitlementsResponse["subscription"] = { id: "sub_1", status: "active", planKey: "BUSINESS" }): RawEntitlementsResponse {
  return { ...app, subscription, entitlements };
}

test("entitlement true -> enabled", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: true }]), "catalog.enabled");
  assert.equal(d.enabled, true);
  assert.equal(d.reason, "granting-subscription");
});

test("entitlement false -> disabled (fail closed)", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: false }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-false");
});

test("entitlement absent -> disabled (fail closed, never assume enabled)", () => {
  const d = interpretCapability(resp([{ key: "other.key", value: true }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-missing");
});

test("entitlement invalid (string) -> disabled", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: "yes" }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-invalid");
});

test("entitlement invalid (numeric, wrong shape for a boolean capability) -> disabled", () => {
  const d = interpretCapability(resp([{ key: "catalog.enabled", value: 1 }]), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "entitlement-invalid");
});

test("no subscription at all -> disabled", () => {
  const d = interpretCapability(resp([], null), "catalog.enabled");
  assert.equal(d.enabled, false);
  assert.equal(d.reason, "no-subscription");
});

test("null response (upstream gave nothing usable) -> disabled", () => {
  const d = interpretCapability(null, "catalog.enabled");
  assert.equal(d.enabled, false);
});

test("readLimit: numeric entitlement -> usable limit", () => {
  const l = readLimit(resp([{ key: "products.max", value: 1000 }]), "products.max");
  assert.equal(l.hasLimit, true);
  assert.equal(l.max, 1000);
});

test("readLimit: non-numeric value -> no usable limit (fail closed, never coerced)", () => {
  const l = readLimit(resp([{ key: "products.max", value: "unlimited" }]), "products.max");
  assert.equal(l.hasLimit, false);
  assert.equal(l.max, null);
});

test("readLimit: NaN/Infinity are rejected even though typeof is 'number'", () => {
  const l1 = readLimit(resp([{ key: "products.max", value: NaN }]), "products.max");
  const l2 = readLimit(resp([{ key: "products.max", value: Infinity }]), "products.max");
  assert.equal(l1.hasLimit, false);
  assert.equal(l2.hasLimit, false);
});

test("readLimit: key absent -> no usable limit", () => {
  const l = readLimit(resp([{ key: "other.key", value: 5 }]), "products.max");
  assert.equal(l.hasLimit, false);
});
