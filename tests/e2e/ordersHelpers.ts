import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";

export interface F23Fixtures {
  platformBaseUrl: string;
  orgA: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgB: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgC: { id: string; slug: string; ownerId: string; ownerToken: string };
  staffA: { id: string; token: string };
  managerA: { id: string; token: string };
  apiKeys: Record<"platformFacingA" | "integrationA" | "platformFacingB", { keyId: string; secret: string; scopes: string[] }>;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/f23-fixtures.json", import.meta.url));

export function loadF23Fixtures(): F23Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("F23 fixtures not found. Run `npm run f23:provision` in ul-platform (with `npm run dev` already running) first.");
  }
}

export async function startApp(): Promise<{ base: string; server: Server; close: () => Promise<void> }> {
  const app = buildApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind app server");
  const base = `http://127.0.0.1:${address.port}/v1`;
  return { base, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

export function registerF23Credentials(fixtures: F23Fixtures) {
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);
  registerServiceCredential(fixtures.orgB.id, fixtures.apiKeys.platformFacingB.secret);
  // orgC deliberately gets no registered credential — proves "no
  // credential provisioned" fails closed too, same as F19/F20/F21/F22
  // (see orders-entitlement.test.ts).
}

export async function call(base: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => undefined)) as { data?: any; error?: any } | undefined;
  return { status: res.status, data: json?.data, error: json?.error, headers: res.headers };
}

/** Creates a product via the real HTTP API (not the repository) so E2E tests exercise the full stack. `price` optional (unset by default, matching ADR-031's nullable Product.price). */
export async function createProduct(base: string, organizationId: string, token: string, name: string, price?: string | number) {
  const res = await call(base, "POST", `/organizations/${organizationId}/products`, { token, body: { name, ...(price !== undefined ? { price } : {}) } });
  if (res.status !== 201) throw new Error(`failed to create fixture product: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}

/** Receives stock for a product via the real HTTP inventory API. */
export async function receiveStock(base: string, organizationId: string, token: string, productId: string, quantity: string | number) {
  const res = await call(base, "POST", `/organizations/${organizationId}/inventory/${productId}/movements`, { token, body: { type: "RECEIPT", quantity } });
  if (res.status !== 201) throw new Error(`failed to seed stock: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}

/** Creates a customer via the real HTTP API. */
export async function createCustomer(base: string, organizationId: string, token: string, name: string) {
  const res = await call(base, "POST", `/organizations/${organizationId}/customers`, { token, body: { name } });
  if (res.status !== 201) throw new Error(`failed to create fixture customer: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}
