/**
 * ADR-013 (F19): business-operation permissions live in Na Pista, keyed
 * by the Platform's global `roleKey` (OWNER/ADMIN/MANAGER/STAFF — the
 * Platform has no application-scoped permission model today).
 *
 * F20 scope: `delete` here means "archive" (ADR-020), never a physical
 * delete — gated the same as any other mutation, one tier stricter than
 * plain write (OWNER/ADMIN only, matching organization.delete's posture
 * in the Platform's own seed).
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  OWNER: [
    "products.read",
    "products.create",
    "products.update",
    "products.delete",
    "categories.read",
    "categories.create",
    "categories.update",
    "categories.delete",
  ],
  ADMIN: [
    "products.read",
    "products.create",
    "products.update",
    "products.delete",
    "categories.read",
    "categories.create",
    "categories.update",
    "categories.delete",
  ],
  MANAGER: ["products.read", "products.create", "products.update", "categories.read", "categories.create", "categories.update"],
  STAFF: ["products.read", "categories.read"],
};

export function roleHasPermission(roleKey: string, permission: string): boolean {
  return (ROLE_PERMISSIONS[roleKey] ?? []).includes(permission);
}
