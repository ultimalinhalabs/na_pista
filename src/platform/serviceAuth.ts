/**
 * F29A: NOT the runtime credential source any more. Platform credentials are
 * persisted encrypted in PostgreSQL and resolved by
 * `modules/platformCredentials/resolver.ts` — a normal `npm run dev`/`start`
 * never needs anything registered here.
 *
 * What remains is an explicit TEST/DEV override store, kept so the existing
 * F20–F29 e2e harness (which injects fixture credentials per test run) and
 * the `mv:server` launcher keep working unchanged. The resolver consults it
 * ONLY when (a) the database has no row at all for the organization and
 * (b) NODE_ENV is not "production". Production never reads it, and a
 * persisted REVOKED credential can never be bypassed through it.
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

/** How many overrides are registered — lets tests prove the runtime works with none. */
export function registeredServiceCredentialCount(): number {
  return credentials.size;
}
