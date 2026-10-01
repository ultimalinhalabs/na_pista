import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, queryClient } from "../../src/db/index.js";
import { organizationPlatformCredentials } from "../../src/db/schema/index.js";
import * as c from "../../src/contract/schemas.js";
import { invalidatePlatformCredentialCache } from "../../src/modules/platformCredentials/resolver.js";
import { provisionPlatformCredential, revokePlatformCredential } from "../../src/modules/platformCredentials/service.js";
import { loadF23Fixtures, registerF23Credentials, startApp } from "./ordersHelpers.js";

/**
 * F30 over real HTTP, real UL Platform, real PostgreSQL:
 *  - contract conformance: every resource is exercised the way an external
 *    "custom UI" would, and every response is validated against the
 *    published response schemas (strict: an undocumented field fails);
 *  - pagination / sorting / error contract on authenticated routes;
 *  - credential status, audit read, and the absence of a webhook proxy;
 *  - secrets never appear in any response.
 */
const fx = loadF23Fixtures();
let ctx: Awaited<ReturnType<typeof startApp>>;
const A = fx.orgA.id;
const B = fx.orgB.id;
const SECRETS = [fx.apiKeys.platformFacingA.secret, fx.apiKeys.integrationA.secret, fx.apiKeys.platformFacingB.secret];
const bodies: string[] = [];

before(async () => {
  ctx = await startApp();
  registerF23Credentials(fx);
});
after(async () => {
  await db.delete(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, A));
  await ctx.close();
  await queryClient.end({ timeout: 5 });
});

async function api(method: string, path: string, opts: { token?: string; body?: unknown; rawBody?: string } = {}) {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : undefined, headers: res.headers };
}

const owner = fx.orgA.ownerToken;
const data = <T extends z.ZodType>(schema: T) => c.dataEnvelope(schema);
const list = <T extends z.ZodType>(schema: T) => z.strictObject({ data: z.array(schema) });
const pageOf = <T extends z.ZodType>(schema: T) => c.pageEnvelope(schema);
/** Asserts the status and the published schema; returns the response typed BY that schema. */
function expect<T extends z.ZodType>(res: { status: number; json: unknown }, status: number, schema: T): z.infer<T> {
  assert.equal(res.status, status, JSON.stringify(res.json));
  const parsed = schema.safeParse(res.json);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 800));
  return parsed.data as z.infer<T>;
}

const runTag = Date.now().toString(36);
const ids: Record<string, string> = {};

test("catalogue + stock + orders: every response matches the published contract", async () => {
  const cat = expect(await api("POST", `/organizations/${A}/categories`, { token: owner, body: { name: `F30 Cat ${runTag}` } }), 201, data(c.CategorySchema));
  ids.category = cat.data.id;
  expect(await api("GET", `/organizations/${A}/categories/${ids.category}`, { token: owner }), 200, data(c.CategorySchema));
  expect(await api("PATCH", `/organizations/${A}/categories/${ids.category}`, { token: owner, body: { description: "x" } }), 200, data(c.CategorySchema));
  expect(await api("GET", `/organizations/${A}/categories?pageSize=5`, { token: owner }), 200, pageOf(c.CategorySchema));

  const prod = expect(
    await api("POST", `/organizations/${A}/products`, { token: owner, body: { name: `F30 Prod ${runTag}`, price: "1500.00", categoryId: ids.category } }),
    201,
    data(c.ProductSchema),
  );
  ids.product = prod.data.id;
  expect(await api("GET", `/organizations/${A}/products/${ids.product}`, { token: owner }), 200, data(c.ProductSchema));
  expect(await api("PATCH", `/organizations/${A}/products/${ids.product}`, { token: owner, body: { description: "y" } }), 200, data(c.ProductSchema));

  const cust = expect(await api("POST", `/organizations/${A}/customers`, { token: owner, body: { name: `F30 Cliente ${runTag}` } }), 201, data(c.CustomerSchema));
  ids.customer = cust.data.id;
  expect(await api("GET", `/organizations/${A}/customers/${ids.customer}`, { token: owner }), 200, data(c.CustomerSchema));
  expect(await api("GET", `/organizations/${A}/customers?q=F30`, { token: owner }), 200, pageOf(c.CustomerSchema));

  expect(
    await api("POST", `/organizations/${A}/inventory/${ids.product}/movements`, { token: owner, body: { type: "RECEIPT", quantity: 10 } }),
    201,
    data(c.StockMovementResultSchema),
  );
  expect(await api("GET", `/organizations/${A}/inventory/${ids.product}`, { token: owner }), 200, data(c.InventoryBalanceSchema));
  expect(await api("GET", `/organizations/${A}/inventory?sort=quantity&order=asc`, { token: owner }), 200, pageOf(c.InventoryBalanceSchema));
  expect(await api("GET", `/organizations/${A}/inventory/${ids.product}/movements`, { token: owner }), 200, pageOf(c.StockMovementSchema));
});

test("orders lifecycle: create → add item → change quantity → confirm → complete, all on-contract", async () => {
  const order = expect(await api("POST", `/organizations/${A}/orders`, { token: owner, body: { customerId: ids.customer } }), 201, data(c.OrderDetailSchema));
  ids.order = order.data.id;
  const withItem = expect(
    await api("POST", `/organizations/${A}/orders/${ids.order}/items`, { token: owner, body: { productId: ids.product, quantity: 2 } }),
    201,
    data(c.OrderDetailSchema),
  );
  const itemId = withItem.data.items[0]!.id;
  expect(await api("PATCH", `/organizations/${A}/orders/${ids.order}/items/${itemId}`, { token: owner, body: { quantity: 3 } }), 200, data(c.OrderDetailSchema));
  const confirmed = expect(await api("POST", `/organizations/${A}/orders/${ids.order}/confirm`, { token: owner }), 200, data(c.OrderDetailSchema));
  assert.equal(confirmed.data.total, "4500.00");
  expect(await api("POST", `/organizations/${A}/orders/${ids.order}/complete`, { token: owner }), 200, data(c.OrderDetailSchema));
  expect(await api("GET", `/organizations/${A}/orders/${ids.order}`, { token: owner }), 200, data(c.OrderDetailSchema));
  expect(await api("GET", `/organizations/${A}/orders?status=COMPLETED&customerId=${ids.customer}`, { token: owner }), 200, pageOf(c.OrderSchema));
});

test("services → professionals → schedule → availability → booking: all on-contract", async () => {
  const svc = expect(await api("POST", `/organizations/${A}/services`, { token: owner, body: { name: `F30 Corte ${runTag}`, durationMinutes: 30, price: "2000.00" } }), 201, data(c.ServiceSchema));
  ids.service = svc.data.id;
  expect(await api("GET", `/organizations/${A}/services/${ids.service}`, { token: owner }), 200, data(c.ServiceSchema));
  expect(await api("GET", `/organizations/${A}/services?sort=name&order=asc`, { token: owner }), 200, pageOf(c.ServiceSchema));

  const pro = expect(await api("POST", `/organizations/${A}/professionals`, { token: owner, body: { name: `F30 Prof ${runTag}` } }), 201, data(c.ProfessionalSchema));
  ids.professional = pro.data.id;
  expect(
    await api("POST", `/organizations/${A}/professionals/${ids.professional}/services/${ids.service}`, { token: owner }),
    201,
    data(c.ProfessionalServiceAssociationSchema),
  );
  expect(await api("GET", `/organizations/${A}/professionals/${ids.professional}/services`, { token: owner }), 200, list(c.AssociatedServiceSchema));
  expect(await api("GET", `/organizations/${A}/professionals?serviceId=${ids.service}`, { token: owner }), 200, pageOf(c.ProfessionalSchema));

  const settings = await api("GET", `/organizations/${A}/settings`, { token: owner });
  expect(settings, 200, data(c.OrganizationSettingsSchema.nullable()));
  expect(await api("PUT", `/organizations/${A}/settings`, { token: owner, body: { timezone: "Africa/Luanda" } }), 200, data(c.OrganizationSettingsSchema));

  const rules = [1, 2, 3, 4, 5, 6, 0].map((dayOfWeek) => ({ dayOfWeek, startLocalTime: "08:00", endLocalTime: "18:00" }));
  expect(await api("PUT", `/organizations/${A}/professionals/${ids.professional}/schedule`, { token: owner, body: { rules } }), 200, list(c.ScheduleRuleSchema));
  expect(await api("GET", `/organizations/${A}/professionals/${ids.professional}/schedule`, { token: owner }), 200, list(c.ScheduleRuleSchema));

  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const ex = expect(
    await api("POST", `/organizations/${A}/professionals/${ids.professional}/schedule/exceptions`, { token: owner, body: { date: later } }),
    201,
    data(c.ScheduleExceptionSchema),
  );
  expect(await api("GET", `/organizations/${A}/professionals/${ids.professional}/schedule/exceptions`, { token: owner }), 200, list(c.ScheduleExceptionSchema));
  expect(
    await api("DELETE", `/organizations/${A}/professionals/${ids.professional}/schedule/exceptions/${ex.data.id}`, { token: owner }),
    200,
    data(c.RemovedSchema),
  );
  expect(
    await api("GET", `/organizations/${A}/professionals/${ids.professional}/availability?from=${day}&to=${day}&serviceId=${ids.service}`, { token: owner }),
    200,
    data(c.AvailabilitySchema),
  );
  const slots = expect(
    await api("GET", `/organizations/${A}/professionals/${ids.professional}/bookable-slots?date=${day}&serviceId=${ids.service}`, { token: owner }),
    200,
    data(c.BookableSlotsSchema),
  );
  assert.ok(slots.data.slots.length > 0, "a fully-open day has bookable slots");

  const appt = expect(
    await api("POST", `/organizations/${A}/appointments`, {
      token: owner,
      body: { customerId: ids.customer, professionalId: ids.professional, serviceId: ids.service, startAt: slots.data.slots[0]!.startAt },
    }),
    201,
    data(c.AppointmentSchema),
  );
  ids.appointment = appt.data.id;
  expect(await api("GET", `/organizations/${A}/appointments/${ids.appointment}`, { token: owner }), 200, data(c.AppointmentSchema));
  expect(await api("PATCH", `/organizations/${A}/appointments/${ids.appointment}`, { token: owner, body: { notes: "contrato" } }), 200, data(c.AppointmentSchema));
  expect(await api("GET", `/organizations/${A}/appointments?from=${day}&to=${day}`, { token: owner }), 200, pageOf(c.AppointmentSchema));
  expect(await api("POST", `/organizations/${A}/appointments/${ids.appointment}/cancel`, { token: owner, body: { reason: "teste" } }), 200, data(c.AppointmentSchema));
});

test("archive endpoints and association removal are on-contract", async () => {
  expect(await api("DELETE", `/organizations/${A}/professionals/${ids.professional}/services/${ids.service}`, { token: owner }), 200, data(c.RemovedSchema));
  expect(await api("PATCH", `/organizations/${A}/professionals/${ids.professional}`, { token: owner, body: { status: "ARCHIVED" } }), 200, data(c.ProfessionalSchema));
  expect(await api("PATCH", `/organizations/${A}/services/${ids.service}`, { token: owner, body: { status: "ARCHIVED" } }), 200, data(c.ServiceSchema));
  expect(await api("DELETE", `/organizations/${A}/customers/${ids.customer}`, { token: owner }), 200, data(c.CustomerSchema));
  expect(await api("DELETE", `/organizations/${A}/products/${ids.product}`, { token: owner }), 200, data(c.ProductSchema));
  expect(await api("DELETE", `/organizations/${A}/categories/${ids.category}`, { token: owner }), 200, data(c.CategorySchema));
});

test("pagination over HTTP: envelope, page 2, tenant-scoped totals, invalid values with field details", async () => {
  const p1 = expect(await api("GET", `/organizations/${A}/products?pageSize=1&page=1`, { token: owner }), 200, pageOf(c.ProductSchema));
  assert.equal(p1.pagination.pageSize, 1);
  assert.ok(p1.pagination.total >= 1);
  assert.equal(p1.pagination.totalPages, p1.pagination.total);
  if (p1.pagination.total > 1) {
    const p2 = expect(await api("GET", `/organizations/${A}/products?pageSize=1&page=2`, { token: owner }), 200, pageOf(c.ProductSchema));
    assert.notEqual(p2.data[0]!.id, p1.data[0]!.id);
  }
  const bProducts = expect(await api("GET", `/organizations/${B}/products?pageSize=100`, { token: fx.orgB.ownerToken }), 200, pageOf(c.ProductSchema));
  assert.ok(bProducts.data.every((p: { organizationId: string }) => p.organizationId === B));

  const bad = await api("GET", `/organizations/${A}/products?page=0`, { token: owner });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "VALIDATION_ERROR");
  assert.deepEqual(bad.json.error.details.map((d: { location: string; path: string }) => [d.location, d.path]), [["query", "page"]]);
  const both = await api("GET", `/organizations/${A}/products?limit=2&pageSize=2`, { token: owner });
  assert.equal(both.status, 400);
  const legacy = expect(await api("GET", `/organizations/${A}/products?limit=1`, { token: owner }), 200, pageOf(c.ProductSchema));
  assert.equal(legacy.data.length, 1, "deprecated `limit` still honoured");
});

test("sorting over HTTP: allowlisted only; injection-shaped values never reach SQL", async () => {
  expect(await api("GET", `/organizations/${A}/products?sort=name&order=desc`, { token: owner }), 200, pageOf(c.ProductSchema));
  for (const qs of ["sort=price", "sort=name%3BDROP%20TABLE%20products", "order=sideways", "sort=organizationId"]) {
    const r = await api("GET", `/organizations/${A}/products?${qs}`, { token: owner });
    assert.equal(r.status, 400, qs);
    assert.equal(r.json.error.details[0].location, "query");
  }
});

test("authenticated error contract: malformed path id → 400 (was 500), unknown route → JSON 404", async () => {
  const badId = await api("GET", `/organizations/${A}/products/not-a-uuid`, { token: owner });
  assert.equal(badId.status, 400);
  assert.deepEqual(badId.json.error.details, [{ location: "path", path: "productId", message: "Must be a valid UUID" }]);
  assert.ok(badId.headers.get("x-request-id"));
  expect(badId, 400, c.ErrorResponseSchema);

  const unknown = await api("GET", `/organizations/${A}/definitely-not-a-route`, { token: owner });
  assert.equal(unknown.status, 404);
  expect(unknown, 404, c.ErrorResponseSchema);

  const badJson = await api("POST", `/organizations/${A}/products`, { token: owner, rawBody: "{" });
  assert.equal(badJson.status, 400);
  expect(badJson, 400, c.ErrorResponseSchema);
});

test("webhooks: Na Pista exposes no webhook API of its own (Platform-owned, ADR-057)", async () => {
  const r = await api("GET", `/organizations/${A}/webhooks`, { token: owner });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "NOT_FOUND");
});

test("credential status: missing → ACTIVE → REVOKED, OWNER only, not behind the capability gate, never a secret", async () => {
  await db.delete(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, A));
  invalidatePlatformCredentialCache(A);
  const path = `/organizations/${A}/platform-credential`;
  const missing = expect(await api("GET", path, { token: owner }), 200, data(c.PlatformCredentialStatusSchema));
  assert.deepEqual(missing.data, { configured: false, status: null, createdAt: null, updatedAt: null, revokedAt: null });

  await provisionPlatformCredential({ organizationId: A, credential: fx.apiKeys.platformFacingA.secret }, { actor: { type: "user", id: "f30-e2e" } });
  const active = expect(await api("GET", path, { token: owner }), 200, data(c.PlatformCredentialStatusSchema));
  assert.equal(active.data.configured, true);
  assert.equal(active.data.status, "ACTIVE");

  await revokePlatformCredential(A, { actor: { type: "user", id: "f30-e2e" }, reason: "f30 e2e" });
  const revoked = expect(await api("GET", path, { token: owner }), 200, data(c.PlatformCredentialStatusSchema));
  assert.equal(revoked.data.status, "REVOKED");
  assert.ok(revoked.data.revokedAt);
  // (Business routes then fail closed once the cached entitlement decision expires — ≤10s, OD-13; proven in a fresh
  // process by platform-credentials-runtime.test.ts. "Readable while the gate fails" is proven below with orgC.)
  await db.delete(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.organizationId, A));
  invalidatePlatformCredentialCache(A); // out-of-band DB edit: tell this process, as the service layer would

  for (const [who, token] of [
    ["STAFF", fx.staffA.token],
    ["MANAGER", fx.managerA.token],
    ["service credential", fx.apiKeys.integrationA.secret],
    ["owner of another org", fx.orgB.ownerToken],
  ] as const) {
    const r = await api("GET", path, { token });
    assert.equal(r.status, 403, who);
  }
  assert.equal((await api("GET", path)).status, 401);

  // orgC has no credential: its business routes fail closed (503, asserted in the audit test) — yet its status is readable.
  const orgC = expect(await api("GET", `/organizations/${fx.orgC.id}/platform-credential`, { token: fx.orgC.ownerToken }), 200, data(c.PlatformCredentialStatusSchema));
  assert.equal(orgC.data.configured, false);
});

test("audit read: OWNER sees this run's events, filtered and paginated; others are refused", async () => {
  const path = `/organizations/${A}/audit-events`;
  const forProduct = expect(
    await api("GET", `${path}?resourceType=product&resourceId=${ids.product}`, { token: owner }),
    200,
    pageOf(c.AuditEventSchema),
  );
  const actions = forProduct.data.map((e: { action: string }) => e.action);
  // Archiving is a DELETE route; its audit action is "product.deleted".
  assert.ok(actions.includes("product.created") && actions.includes("product.deleted"), JSON.stringify(actions));
  const first = expect(await api("GET", `${path}?pageSize=2`, { token: owner }), 200, pageOf(c.AuditEventSchema));
  assert.equal(first.data.length, 2);

  for (const [who, token, status] of [
    ["STAFF", fx.staffA.token, 403],
    ["MANAGER", fx.managerA.token, 403],
    ["service credential", fx.apiKeys.integrationA.secret, 403],
    ["owner of another org", fx.orgB.ownerToken, 403],
  ] as const) {
    assert.equal((await api("GET", path, { token })).status, status, who);
  }
  // B's own audit never contains A's resources.
  const bAudit = expect(await api("GET", `/organizations/${B}/audit-events?resourceId=${ids.product}`, { token: fx.orgB.ownerToken }), 200, pageOf(c.AuditEventSchema));
  assert.equal(bAudit.pagination.total, 0);
  // Behind the capability gate like every business read: orgC has no credential, so the gate fails closed (503) —
  // the same situation in which /platform-credential (ungated) still answers 200 above.
  const gatedAudit = await api("GET", `/organizations/${fx.orgC.id}/audit-events`, { token: fx.orgC.ownerToken });
  assert.equal(gatedAudit.status, 503);
  assert.equal(gatedAudit.json.error.code, "UPSTREAM_UNAVAILABLE");
});

test("no secret appeared in any response of this suite", () => {
  const all = bodies.join("\n");
  for (const secret of SECRETS) assert.ok(!all.includes(secret), "a credential secret leaked into a response");
  // (platformApiKeyId may legitimately appear in credential audit metadata — an identifier, not a secret; ADR-055.)
  for (const marker of ["encryptedCredential", "ciphertext", "NA_PISTA_CREDENTIAL_ENCRYPTION_KEY"]) {
    assert.ok(!all.includes(marker), `response contains ${marker}`);
  }
});
