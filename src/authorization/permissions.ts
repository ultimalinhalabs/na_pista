/**
 * ADR-013 (F19): business-operation permissions live in Na Pista, keyed
 * by the Platform's global `roleKey` (OWNER/ADMIN/MANAGER/STAFF — the
 * Platform has no application-scoped permission model today).
 *
 * F20 scope: `delete` here means "archive" (ADR-020), never a physical
 * delete — gated the same as any other mutation, one tier stricter than
 * plain write (OWNER/ADMIN only, matching organization.delete's posture
 * in the Platform's own seed).
 *
 * F22 (ADR-028): `inventory.create` gates RECEIPT (the movement that can
 * bring a new balance into existence); `inventory.update` gates
 * ADJUSTMENT_IN/ADJUSTMENT_OUT. There is deliberately no
 * `inventory.delete` — no lifecycle operation exists to delete/archive
 * an inventory balance in this slice (F22 brief §19: "do not expose
 * inventory.delete merely because the permission naming convention
 * suggests it").
 *
 * F23: `orders.create` gates `POST /orders`; `orders.update` gates every
 * other mutation — editing a DRAFT (items/customer) AND every lifecycle
 * transition (confirm/cancel/complete) alike. Deliberately NOT split
 * further per-transition (F23 brief §27: "do not invent unnecessary
 * permission granularity") — unlike Inventory's create/update split
 * (which reflects two genuinely different actions, RECEIPT vs
 * ADJUSTMENT), every Order mutation here is the same class of action on
 * the same resource. No `orders.delete` — Orders are never physically
 * deleted; cancellation is a lifecycle transition, gated like any other
 * mutation, not a separate permission tier (mirrors `inventory.delete`'s
 * deliberate absence).
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
    "customers.read",
    "customers.create",
    "customers.update",
    "customers.delete",
    "inventory.read",
    "inventory.create",
    "inventory.update",
    "orders.read",
    "orders.create",
    "orders.update",
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
    "customers.read",
    "customers.create",
    "customers.update",
    "customers.delete",
    "inventory.read",
    "inventory.create",
    "inventory.update",
    "orders.read",
    "orders.create",
    "orders.update",
  ],
  MANAGER: [
    "products.read",
    "products.create",
    "products.update",
    "categories.read",
    "categories.create",
    "categories.update",
    "customers.read",
    "customers.create",
    "customers.update",
    "inventory.read",
    "inventory.create",
    "inventory.update",
    "orders.read",
    "orders.create",
    "orders.update",
  ],
  STAFF: ["products.read", "categories.read", "customers.read", "inventory.read", "orders.read"],
};

export function roleHasPermission(roleKey: string, permission: string): boolean {
  return (ROLE_PERMISSIONS[roleKey] ?? []).includes(permission);
}
