import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerServiceCredential } from "../../src/platform/serviceAuth.js";
import { addDays, localToInstant, toLocal } from "../../src/modules/appointments/time.js";
import { call, createProfessional, createService, setTimezone, startApp } from "./schedulingHelpers.js";

export { call, createProfessional, createService, setTimezone, startApp };

export interface F27Fixtures {
  platformBaseUrl: string;
  orgA: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgB: { id: string; slug: string; ownerId: string; ownerToken: string; subscriptionId: string };
  orgC: { id: string; slug: string; ownerId: string; ownerToken: string };
  staffA: { id: string; token: string };
  managerA: { id: string; token: string };
  apiKeys: Record<"platformFacingA" | "integrationA" | "platformFacingB", { keyId: string; secret: string; scopes: string[] }>;
}

const fixturesPath = fileURLToPath(new URL("../../.fixtures/f27-fixtures.json", import.meta.url));

export function loadF27Fixtures(): F27Fixtures {
  try {
    return JSON.parse(readFileSync(fixturesPath, "utf8"));
  } catch {
    throw new Error("F27 fixtures not found. Run `npm run f27:provision` in ul-platform (with `npm run dev` already running) first.");
  }
}

export function registerF27Credentials(fixtures: F27Fixtures) {
  registerServiceCredential(fixtures.orgA.id, fixtures.apiKeys.platformFacingA.secret);
  registerServiceCredential(fixtures.orgB.id, fixtures.apiKeys.platformFacingB.secret);
  // orgC deliberately gets no registered credential (entitlement tests).
}

export const TZ = "Africa/Luanda";
/** A local date comfortably inside the 365-day booking window. */
export const DAY = addDays(toLocal(new Date(), TZ).date, 12);
/** Absolute ISO instant for an organization-local wall-clock time (the org timezone is always Africa/Luanda in these fixtures). */
export function at(time: string, date = DAY): string {
  return localToInstant(date, time, TZ)!.toISOString();
}

async function expectStatus(res: { status: number; error?: unknown }, status: number, what: string) {
  if (res.status !== status) throw new Error(`failed to ${what}: ${res.status} ${JSON.stringify(res.error)}`);
}

/** Customer + Service (60 min, 10000.00) + Professional associated with it, working 08:00-18:00 every day — all through the real HTTP API. */
export async function seedBookable(base: string, organizationId: string, token: string, label: string, options: { durationMinutes?: number } = {}) {
  const customerRes = await call(base, "POST", `/organizations/${organizationId}/customers`, { token, body: { name: `Cliente ${label}` } });
  await expectStatus(customerRes, 201, "create customer");
  const service = await createService(base, organizationId, token, `Serviço ${label}`, options.durationMinutes ?? 60, "10000.00");
  const professional = await addProfessional(base, organizationId, token, `Profissional ${label}`, service.id);
  return { customer: customerRes.data, service, professional };
}

export async function addProfessional(base: string, organizationId: string, token: string, name: string, serviceId: string) {
  const professional = await createProfessional(base, organizationId, token, name);
  await expectStatus(await call(base, "POST", `/organizations/${organizationId}/professionals/${professional.id}/services/${serviceId}`, { token }), 201, "associate service");
  await expectStatus(
    await call(base, "PUT", `/organizations/${organizationId}/professionals/${professional.id}/schedule`, {
      token,
      body: { rules: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, startLocalTime: "08:00", endLocalTime: "18:00" })) },
    }),
    200,
    "set schedule",
  );
  return professional;
}

export function bookBody(seed: Awaited<ReturnType<typeof seedBookable>>, startAt: string, extra: Record<string, unknown> = {}) {
  return { customerId: seed.customer.id, professionalId: seed.professional.id, serviceId: seed.service.id, startAt, ...extra };
}

/**
 * A fresh, subscribed organization WITHOUT a configured timezone, minted
 * inline (the F26 `scheduling-timezone.test.ts` pattern) so no other test
 * file's timezone setup can leak into it.
 */
export async function createFreshSubscribedOrg(fixtures: F27Fixtures) {
  const ownerToken = fixtures.orgA.ownerToken;
  const org = await call(fixtures.platformBaseUrl, "POST", "/organizations", { token: ownerToken, body: { name: `F27_TZ_PROBE_${Date.now()}` } });
  if (org.status !== 201) throw new Error(`failed to create probe org: ${org.status} ${JSON.stringify(org.error)}`);
  const { _clearMembershipCache } = await import("../../src/platform/membership.js");
  _clearMembershipCache();
  const subscription = await call(fixtures.platformBaseUrl, "POST", `/organizations/${org.data.id}/subscriptions`, { token: ownerToken, body: { applicationKey: "NA_PISTA", planKey: "BUSINESS" } });
  if (subscription.status !== 201) throw new Error(`failed to subscribe probe org: ${subscription.status}`);
  const apiKey = await call(fixtures.platformBaseUrl, "POST", `/organizations/${org.data.id}/api-keys`, {
    token: ownerToken,
    body: { applicationKey: "NA_PISTA", scopes: ["usage.write", "event.publish"] },
  });
  registerServiceCredential(org.data.id, apiKey.data.secret);
  return { id: org.data.id as string, ownerToken };
}

export async function usageQuantity(fixtures: F27Fixtures, organizationId: string, token: string): Promise<number> {
  const res = await fetch(`${fixtures.platformBaseUrl}/organizations/${organizationId}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  return Number(res.data?.quantity ?? 0);
}
