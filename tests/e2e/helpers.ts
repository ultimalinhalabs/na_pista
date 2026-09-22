import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";

export interface Fixtures {
  platformBaseUrl: string;
  orgA: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgB: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgC: { id: string; slug: string; ownerId: string; ownerToken: string };
  orgD: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  staffA: { id: string; token: string };
  outsider: { id: string; token: string };
  apiKeys: Record<"platformFacingA" | "integrationA" | "platformFacingB" | "platformFacingD", { keyId: string; secret: string; scopes: string[] }>;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/f20-fixtures.json", import.meta.url));

export function loadFixtures(): Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("F20 fixtures not found. Run `npm run f20:provision` in ul-platform (with `npm run dev` already running) first.");
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

export function registerFixtureCredentials(fixtures: Fixtures) {
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);
  registerServiceCredential(fixtures.orgB.id, fixtures.apiKeys.platformFacingB.secret);
  registerServiceCredential(fixtures.orgD.id, fixtures.apiKeys.platformFacingD.secret);
  // orgC deliberately gets no registered credential — see entitlements test.
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
