/**
 * OD-12 (CLOSED — part 2: LOCAL permissions). Business-operation
 * permissions live in Na Pista, keyed by the Platform's global `roleKey`
 * (OWNER/ADMIN/MANAGER/STAFF — the Platform has no application-scoped
 * permission model today, see platform-audit.md PG-3). This is exactly
 * the authorization.md §2.2 proposal, narrowed to what the spike's
 * Product resource needs.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: ["products.read", "products.write", "products.delete"],
  ADMIN: ["products.read", "products.write", "products.delete"],
  MANAGER: ["products.read", "products.write"],
  STAFF: ["products.read"],
};

export function roleHasPermission(roleKey: string, permission: string): boolean {
  return (ROLE_PERMISSIONS[roleKey] ?? []).includes(permission);
}
