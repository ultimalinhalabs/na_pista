/**
 * OD-11 (F19, CLOSED — Alternative A): one organization-scoped NA_PISTA
 * API key per Organization, held by Na Pista, used for its OWN outbound
 * calls to the Platform (entitlements, usage, events).
 *
 * In-memory on purpose for now — this mirrors the F19 spike's registry.
 * A real production deployment needs a real secret store (encrypted
 * column keyed by organizationId, or a KMS-backed vault) and
 * provisioning automation tied to subscription lifecycle — not built in
 * F20 either (see docs/f20-report.md "Known limitations"); Products
 * management does not require solving credential storage first.
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
