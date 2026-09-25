/**
 * F23A (ADR-030): a real per-organization currency setting does not exist
 * yet, so Na Pista operates in one single supported currency. Extracted
 * from `orders/service.ts` in F27 (docs/f27a-report.md §10) so Orders and
 * Appointments snapshot the SAME value from ONE source — never two
 * constants that could drift apart. The moment a real per-organization
 * currency setting exists, this is the one place that changes; both
 * `orders.currency` and `appointments.currency` already snapshot whatever
 * it resolves to at creation time.
 */
export const DEFAULT_CURRENCY = "AOA";
