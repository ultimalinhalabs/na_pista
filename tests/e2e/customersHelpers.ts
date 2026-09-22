import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";

export interface F21Fixtures {
  platformBaseUrl: string;
  orgA: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgB: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgC: { id: string; slug: string; ownerId: string; ownerToken: string };
  staffA: { id: string; token: string };
  managerA: { id: string; token: string };
  outsider: { id: string; token: string };
  apiKeys: Record<"platformFacingA" | "integrationA" | "noScopeA" | "platformFacingB", { keyId: string; secret: string; scopes: string[] }>;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/f21-fixtures.json", import.meta.url));

export function loadF21Fixtures(): F21Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("F21 fixtures not found. Run `npm run f21:provision` in ul-platform (with `npm run dev` already running) first.");
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

export function registerF21Credentials(fixtures: F21Fixtures) {
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);
  registerServiceCredential(fixtures.orgB.id, fixtures.apiKeys.platformFacingB.secret);
  // orgC deliberately gets no registered credential — proves "no
  // credential provisioned" fails closed too, same as F19/F20.
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
