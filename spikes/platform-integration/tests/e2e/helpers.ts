import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../src/app.js";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";

export interface Fixtures {
  platformBaseUrl: string;
  orgA: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgB: { id: string; slug: string; ownerId: string; ownerToken: string };
  orgC: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgD: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgE: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  staffA: { id: string; token: string };
  outsider: { id: string; token: string };
  apiKeys: Record<
    | "integrationA"
    | "platformFacingA"
    | "noScopeA"
    | "expiredA"
    | "revokedA"
    | "integrationB"
    | "platformFacingD"
    | "integrationD"
    | "platformFacingE",
    { keyId: string; secret: string; scopes: string[] }
  >;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/f19-fixtures.json", import.meta.url));

export function loadFixtures(): Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error(
      "F19 fixtures not found. Run `npm run f19:provision` in ul-platform (with `npm run dev` already running) first.",
    );
  }
}

export async function startSpike(): Promise<{ base: string; server: Server; close: () => Promise<void> }> {
  const app = buildApp();
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind spike server");
  const base = `http://127.0.0.1:${address.port}/v1`;
  return {
    base,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Registers this spike's own outbound Na Pista service credentials for orgA/orgB/orgC — OD-11 Alternative A, executed. */
export function registerFixtureCredentials(fixtures: Fixtures) {
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);
  registerServiceCredential(fixtures.orgB.id, fixtures.apiKeys.integrationB.secret);
  registerServiceCredential(fixtures.orgD.id, fixtures.apiKeys.platformFacingD.secret);
  registerServiceCredential(fixtures.orgE.id, fixtures.apiKeys.platformFacingE.secret);
  // orgC deliberately gets NO registered outbound credential here — it
  // proves "no credential provisioned for this org" fails closed too
  // (UpstreamUnavailableError -> 503), a distinct case from "credential
  // exists but no granting subscription" (org B).
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => undefined)) as { data?: any; error?: any } | undefined;
  return { status: res.status, data: json?.data, error: json?.error };
}
