import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { _clearEntitlementsCache } from "../../src/platform/entitlements.js";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";
import { call, startApp } from "./servicesHelpers.js";

/**
 * Audit 2026-10-20 / UL migration 0031 — one entitlement per module, end to end against a real (local) UL
 * Platform: `catalog.enabled` no longer opens services/orders/customers, a direct API call is refused the same
 * way a menu would hide it, the Console learns the enabled modules from GET /modules, and organizations stay
 * isolated. Fixtures: `npx tsx scripts/module-entitlements-provision-fixtures.ts` in ul-platform (local UL running).
 */
interface Org {
  id: string;
  ownerToken: string;
  planKey: string;
  platformFacingKey: { keyId: string; secret: string };
}
interface Fixtures {
  orgCatalogOnly: Org;
  orgServicesOnly: Org;
  orgAll: Org;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/module-entitlements-fixtures.json", import.meta.url));
function loadFixtures(): Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("Module-entitlement fixtures not found. Run `npx tsx scripts/module-entitlements-provision-fixtures.ts` in ul-platform (local UL running) first.");
  }
}

let ctx: Awaited<ReturnType<typeof startApp>>;
const f = loadFixtures();
const get = (org: Org, path: string, token = org.ownerToken) => call(ctx.base, "GET", `/organizations/${org.id}${path}`, { token });

before(async () => {
  ctx = await startApp();
  for (const org of [f.orgCatalogOnly, f.orgServicesOnly, f.orgAll]) registerServiceCredential(org.id, org.platformFacingKey.secret);
  _clearEntitlementsCache();
  // Appointments need an organization timezone (settings: any enabled module).
  for (const org of [f.orgServicesOnly, f.orgAll]) {
    const tz = await call(ctx.base, "PUT", `/organizations/${org.id}/settings`, { token: org.ownerToken, body: { timezone: "Africa/Luanda" } });
    assert.equal(tz.status, 200, JSON.stringify(tz.error));
  }
});
after(() => ctx.close());

const CATALOG = ["/products", "/categories", "/inventory"];
const ORDERS = ["/orders"];
const CUSTOMERS = ["/customers"];
const SERVICES = ["/services", "/professionals", "/appointments?from=2026-10-20&to=2026-10-27"];

async function expectStatus(org: Org, paths: string[], status: number, code?: string) {
  for (const path of paths) {
    const res = await get(org, path);
    assert.equal(res.status, status, `${org.planKey} GET ${path} → ${res.status} ${JSON.stringify(res.error)}`);
    if (code) assert.equal(res.error?.code, code, path);
  }
}

test("catalog only: products/categories/stock work; services, professionals, appointments, orders and customers are refused (403 ENTITLEMENT_REQUIRED) even by direct API call", async () => {
  await expectStatus(f.orgCatalogOnly, CATALOG, 200);
  await expectStatus(f.orgCatalogOnly, [...SERVICES, ...ORDERS, ...CUSTOMERS], 403, "ENTITLEMENT_REQUIRED");
  const create = await call(ctx.base, "POST", `/organizations/${f.orgCatalogOnly.id}/services`, { token: f.orgCatalogOnly.ownerToken, body: { name: "Corte", durationMinutes: 30 } });
  assert.equal(create.status, 403);
  assert.equal(create.error?.code, "ENTITLEMENT_REQUIRED");
});

test("services only (with its customers dependency): services/professionals/appointments and customers work; catalog and orders are refused", async () => {
  await expectStatus(f.orgServicesOnly, [...SERVICES, ...CUSTOMERS], 200);
  await expectStatus(f.orgServicesOnly, [...CATALOG, ...ORDERS], 403, "ENTITLEMENT_REQUIRED");
});

test("every module: a plan with all module keys (BUSINESS) keeps today's access", async () => {
  await expectStatus(f.orgAll, [...CATALOG, ...ORDERS, ...CUSTOMERS, ...SERVICES], 200);
});

test("GET /modules tells the Console exactly which modules to show; organization-wide features need any module", async () => {
  assert.deepEqual((await get(f.orgCatalogOnly, "/modules")).data, { catalog: true, orders: false, customers: false, services: false });
  assert.deepEqual((await get(f.orgServicesOnly, "/modules")).data, { catalog: false, orders: false, customers: true, services: true });
  assert.deepEqual((await get(f.orgAll, "/modules")).data, { catalog: true, orders: true, customers: true, services: true });
  await expectStatus(f.orgCatalogOnly, ["/audit-events", "/settings"], 200);
  await expectStatus(f.orgServicesOnly, ["/audit-events", "/settings"], 200);
});

test("isolation: an owner of one organization cannot read another organization's modules or data, whatever its plan", async () => {
  for (const path of ["/modules", "/services", "/products"]) {
    const cross = await get(f.orgServicesOnly, path, f.orgCatalogOnly.ownerToken);
    assert.equal(cross.status, 403, path);
    assert.equal(cross.error?.code, "FORBIDDEN", path);
  }
});
