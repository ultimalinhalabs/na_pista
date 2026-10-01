import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "@readme/openapi-parser";
import type { Router } from "express";
import { buildApp } from "../../src/app.js";
import { buildOpenApiDocument } from "../../src/contract/openapi.js";
import { operations } from "../../src/contract/operations.js";
import { appointmentsRouter } from "../../src/modules/appointments/routes.js";
import { auditRouter } from "../../src/modules/audit/routes.js";
import { platformCredentialsRouter } from "../../src/modules/platformCredentials/routes.js";
import { categoriesRouter } from "../../src/modules/categories/routes.js";
import { customersRouter } from "../../src/modules/customers/routes.js";
import { inventoryRouter } from "../../src/modules/inventory/routes.js";
import { ordersRouter } from "../../src/modules/orders/routes.js";
import { organizationSettingsRouter } from "../../src/modules/organizationSettings/routes.js";
import { productsRouter } from "../../src/modules/products/routes.js";
import { professionalsRouter } from "../../src/modules/professionals/routes.js";
import { schedulingRouter } from "../../src/modules/scheduling/routes.js";
import { servicesRouter } from "../../src/modules/services/routes.js";

/** ADR-054 — the published contract is valid, committed, and matches the real router exactly. */

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
function routesOf(stack: Layer[], prefix = "") {
  return stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${prefix}${l.route!.path}`));
}

/** Every module router is mounted at /v1 (src/app.ts); app-level routes are read from the app itself. */
function expressRoutes(): string[] {
  const moduleRouters: Router[] = [
    categoriesRouter,
    productsRouter,
    customersRouter,
    inventoryRouter,
    ordersRouter,
    servicesRouter,
    professionalsRouter,
    organizationSettingsRouter,
    schedulingRouter,
    appointmentsRouter,
    auditRouter,
    platformCredentialsRouter,
  ];
  const app = buildApp() as unknown as { router: { stack: Layer[] } };
  return [
    ...routesOf(app.router.stack),
    ...moduleRouters.flatMap((r) => routesOf((r as unknown as { stack: Layer[] }).stack, "/v1")),
  ].sort();
}

test("the generated document is a valid OpenAPI 3.1 document", async () => {
  const result = await validate(structuredClone(buildOpenApiDocument()) as never);
  assert.equal(result.valid, true, JSON.stringify(result.valid ? [] : result.errors).slice(0, 2000));
});

test("docs/api/openapi.json is exactly the generated document (run `npm run openapi:generate`)", () => {
  const committed = JSON.parse(readFileSync(fileURLToPath(new URL("../../docs/api/openapi.json", import.meta.url)), "utf8"));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(buildOpenApiDocument())));
});

test("every Express route is documented, and every documented operation exists (both directions)", () => {
  const real = expressRoutes();
  const documented = operations.map((op) => `${op.method.toUpperCase()} /v1${op.path}`).sort();
  assert.deepEqual(
    real.filter((r) => !documented.includes(r)),
    [],
    "undocumented routes",
  );
  assert.deepEqual(
    documented.filter((d) => !real.includes(d)),
    [],
    "documented operations that do not exist",
  );
  assert.equal(new Set(documented).size, documented.length, "no duplicate operations");
});

test("operation ids are unique; every authenticated operation declares a permission", () => {
  const doc = buildOpenApiDocument();
  const ids: string[] = [];
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      ids.push(op.operationId as string);
      const isPublic = Array.isArray(op.security) && (op.security as unknown[]).length === 0;
      if (!isPublic) assert.ok(op["x-na-pista-permission"], `${method} ${path} has no permission`);
    }
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("the contract never documents secret-bearing fields", () => {
  const text = JSON.stringify(buildOpenApiDocument());
  for (const forbidden of ["encryptedCredential", "secretEncrypted", "ciphertext", "platformApiKeyId", "NA_PISTA_CREDENTIAL_ENCRYPTION_KEY"]) {
    assert.ok(!text.includes(forbidden), `contract mentions ${forbidden}`);
  }
});
