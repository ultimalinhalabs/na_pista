import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";

export interface F26Fixtures {
  platformBaseUrl: string;
  orgA: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgB: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgC: { id: string; slug: string; ownerId: string; ownerToken: string };
  staffA: { id: string; token: string };
  managerA: { id: string; token: string };
  apiKeys: Record<"platformFacingA" | "integrationA" | "platformFacingB", { keyId: string; secret: string; scopes: string[] }>;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/f26-fixtures.json", import.meta.url));

export function loadF26Fixtures(): F26Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("F26 fixtures not found. Run `npm run f26:provision` in ul-platform (with `npm run dev` already running) first.");
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

export function registerF26Credentials(fixtures: F26Fixtures) {
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);
  registerServiceCredential(fixtures.orgB.id, fixtures.apiKeys.platformFacingB.secret);
  // orgC deliberately gets no registered credential — proves "no
  // credential provisioned" fails closed too, same as F19-F24 (see
  // professionals-entitlement.test.ts).
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

/** Creates a Service via the real HTTP API (not the repository) so E2E tests exercise the full stack. */
export async function createService(base: string, organizationId: string, token: string, name: string, durationMinutes: number, price?: string | number) {
  const res = await call(base, "POST", `/organizations/${organizationId}/services`, { token, body: { name, durationMinutes, ...(price !== undefined ? { price } : {}) } });
  if (res.status !== 201) throw new Error(`failed to create fixture service: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}

/** Creates a Professional via the real HTTP API. */
export async function createProfessional(base: string, organizationId: string, token: string, name: string) {
  const res = await call(base, "POST", `/organizations/${organizationId}/professionals`, { token, body: { name } });
  if (res.status !== 201) throw new Error(`failed to create fixture professional: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}

/** Sets the organization's timezone via the real HTTP API — required before any availability computation (ADR-040 "fail closed"). */
export async function setTimezone(base: string, organizationId: string, token: string, timezone = "Africa/Luanda") {
  const res = await call(base, "PUT", `/organizations/${organizationId}/settings`, { token, body: { timezone } });
  if (res.status !== 200) throw new Error(`failed to set fixture timezone: ${res.status} ${JSON.stringify(res.error)}`);
  return res.data;
}
