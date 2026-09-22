/**
 * OD-11 (CLOSED — Alternative A: one organization-scoped NA_PISTA API key
 * per Organization). This is the registry of Na Pista's OWN outbound
 * credentials, one per organization it currently acts for — used by
 * platform/entitlements.ts and (in the outbox, not built in this spike)
 * usage/event publishing.
 *
 * In-memory on purpose: this is spike code (F19 §3 "small and removable").
 * A real deployment needs a real secret store (see docs/decisions.md
 * ADR-011 "Operational implications") — this Map is not that.
 */
const credentials = new Map<string, string>();

export function registerServiceCredential(organizationId: string, secret: string) {
  credentials.set(organizationId, secret);
}

export function getServiceCredential(organizationId: string): string | undefined {
  return credentials.get(organizationId);
}

export function clearServiceCredentials() {
  credentials.clear();
}
