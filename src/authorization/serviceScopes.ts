/**
 * Service-credential scopes per resource (credentials audit 2026-10-23). Personal data — customers, orders,
 * appointments — has its own UL Platform scopes (migration 0032); everything else stays on `catalog.*`. Free
 * bookable slots carry no personal data, so they stay on `catalog.read` (a booking interface needs them).
 *
 * TRANSITION: a key issued before these scopes existed holds only `catalog.*`. While
 * NA_PISTA_LEGACY_CATALOG_SCOPES=refuse (the default since the production inventory of 2026-10-26 showed no
 * key depends on it) such a key is refused on these routes; `accept` is an emergency switch that admits it again and
 * logs the use once per key and scope (`service.legacy_scope_used`). Keys of any
 * other application are refused before this point (tenancy/tenantContext.ts).
 */
export const SERVICE_SCOPES = {
  catalogRead: "catalog.read",
  catalogWrite: "catalog.write",
  customerRead: "customer.read",
  customerWrite: "customer.write",
  orderRead: "order.read",
  orderWrite: "order.write",
  appointmentRead: "appointment.read",
  appointmentWrite: "appointment.write",
  // Interface credential (UL migration 0033): create-only, for a customer-facing interface's server-side key.
  orderCreate: "order.create",
  customerCreate: "customer.create",
} as const;

/** Scope → the legacy scope still accepted for it during the transition. */
export const LEGACY_SCOPE: Readonly<Record<string, string>> = {
  [SERVICE_SCOPES.customerRead]: SERVICE_SCOPES.catalogRead,
  [SERVICE_SCOPES.customerWrite]: SERVICE_SCOPES.catalogWrite,
  [SERVICE_SCOPES.orderRead]: SERVICE_SCOPES.catalogRead,
  [SERVICE_SCOPES.orderWrite]: SERVICE_SCOPES.catalogWrite,
  [SERVICE_SCOPES.appointmentRead]: SERVICE_SCOPES.catalogRead,
  [SERVICE_SCOPES.appointmentWrite]: SERVICE_SCOPES.catalogWrite,
};

/** The scope of a resource permission (`customers.read` → `customer.read`); the contract and the routes use it. */
export function serviceScopeFor(permission: string, kind: "read" | "write"): string {
  const resource = permission.split(".")[0];
  if (resource === "customers") return kind === "read" ? SERVICE_SCOPES.customerRead : SERVICE_SCOPES.customerWrite;
  if (resource === "orders") return kind === "read" ? SERVICE_SCOPES.orderRead : SERVICE_SCOPES.orderWrite;
  if (resource === "appointments") return kind === "read" ? SERVICE_SCOPES.appointmentRead : SERVICE_SCOPES.appointmentWrite;
  return kind === "read" ? SERVICE_SCOPES.catalogRead : SERVICE_SCOPES.catalogWrite;
}
