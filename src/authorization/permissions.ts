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
 *
 * F24 (ADR-033, F24A §14): `services.create` gates `POST /services`;
 * `services.update` gates every other mutation, INCLUDING archive/
 * reactivate (`PATCH { status }`) — no `services.delete`. A deliberate,
 * reasoned departure from Product/Customer/Category's own OWNER/ADMIN-
 * only archive tier: F24A found no Service-specific reason to restrict
 * archiving more tightly than any other write, following Inventory's/
 * Orders' more recent "no extra tier without a specific reason" posture
 * instead.
 *
 * F25 (ADR-036/037, F25A §8): `professionals.create` gates `POST
 * /professionals`; `professionals.update` gates every other mutation,
 * INCLUDING archive/reactivate AND managing `professional_services`
 * associations (create/remove) — no separate
 * `professional_services.manage` tier (mirrors Order's own item-
 * management precedent: one permission covers a resource's own fields
 * and its closely-related sub-resource). No `professionals.delete` —
 * reasoned independently for Professional (not copied from Service),
 * same conclusion: no demonstrated need for a stricter tier.
 *
 * F26 (ADR-039, docs/f26-report.md §14): `scheduling.create` gates
 * `POST .../schedule/exceptions` (the one real "create a new row" verb
 * in this domain); `scheduling.update` gates every other Scheduling
 * mutation — `PUT .../schedule` (whole-set replace of an already-
 * existing, possibly-empty schedule, so "update" not "create"; ADR-039
 * D31: no separate schedule lifecycle exists to "create"),
 * `DELETE .../schedule/exceptions/:id`, AND `organization_settings`
 * (timezone) updates — reused for settings rather than inventing a
 * dedicated `organization_settings.*` namespace, since settings exists
 * solely to support Scheduling today. Reasoned independently for
 * Scheduling (not copied from Professional without justification):
 * every mutation here is structurally "configure this Professional's
 * own operational data," with no distinct classes of action the way
 * Inventory's RECEIPT-vs-ADJUSTMENT split has, so a two-tier create/
 * update split (matching Professional's own shape) is justified, not
 * just copied. No `scheduling.delete` — removal is gated by
 * `scheduling.update`, never a separate lifecycle tier.
 *
 * F27 (ADR-043, docs/f27a-report.md §36): `appointments.create` gates
 * `POST /appointments`; `appointments.update` gates EVERY mutation of an
 * existing appointment — reschedule, notes, cancel AND complete — the
 * `orders.update` precedent (every Order transition is one tier, F23); no
 * demonstrated need for separate cancel/complete permissions. No
 * `appointments.delete` — appointments are never deleted (cancel is a
 * transition). STAFF read-only, consistent with every other module
 * (frozen F27 decision).
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
    "services.read",
    "services.create",
    "services.update",
    "professionals.read",
    "professionals.create",
    "professionals.update",
    "scheduling.read",
    "scheduling.create",
    "scheduling.update",
    "appointments.read",
    "appointments.create",
    "appointments.update",
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
    "services.read",
    "services.create",
    "services.update",
    "professionals.read",
    "professionals.create",
    "professionals.update",
    "scheduling.read",
    "scheduling.create",
    "scheduling.update",
    "appointments.read",
    "appointments.create",
    "appointments.update",
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
    "services.read",
    "services.create",
    "services.update",
    "professionals.read",
    "professionals.create",
    "professionals.update",
    "scheduling.read",
    "scheduling.create",
    "scheduling.update",
    "appointments.read",
    "appointments.create",
    "appointments.update",
  ],
  STAFF: [
    "products.read",
    "categories.read",
    "customers.read",
    "inventory.read",
    "orders.read",
    "services.read",
    "professionals.read",
    "scheduling.read",
    "appointments.read",
  ],
};

export function roleHasPermission(roleKey: string, permission: string): boolean {
  return (ROLE_PERMISSIONS[roleKey] ?? []).includes(permission);
}
