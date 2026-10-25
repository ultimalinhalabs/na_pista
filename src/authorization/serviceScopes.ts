/**
 * Service-credential scopes per resource (credentials audit 2026-10-23). Personal data — customers, orders,
 * appointments — has its own UL Platform scopes (migration 0032); everything else stays on `catalog.*`. Free
 * bookable slots carry no personal data, so they stay on `catalog.read` (a booking interface needs them).
 *
 * TRANSITION: a key issued before these scopes existed holds only `catalog.*`. While
 * NA_PISTA_LEGACY_CATALOG_SCOPES=accept (the default), such a NA_PISTA key is still accepted on these routes and
 * the use is logged once per key and scope (`service.legacy_scope_used`); `refuse` is the strict mode. Keys of any
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
