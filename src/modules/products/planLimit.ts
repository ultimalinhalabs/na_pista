import { and, count, eq, sql } from "drizzle-orm";
import type { db } from "../../db/index.js";
import { products } from "../../db/schema/index.js";
import { fetchEntitlements, readLimit, type LimitDecision } from "../../platform/entitlements.js";
import { EntitlementRequiredError, LimitExceededError } from "../../shared/errors.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The plan's maximum number of ACTIVE products for an organization — emitted
 * by UL Platform as the `products.max` entitlement of the organization's
 * NA_PISTA plan (ADR-014/ADR-022: Na Pista never resolves plans itself) and
 * enforced HERE, on the server, for every path that makes a product active:
 * creation and reactivation of an archived product. Archiving is always
 * allowed. A plan without `products.max` is REFUSED (UL entitlement definition
 * `products.max`: absent policy `deny` — audit 2026-10-20: an absent limit never
 * silently means unlimited; every Na Pista plan sets it); a value that is
 * present but not a non-negative integer fails closed too. When a plan is
 * downgraded below the current count, existing products stay (nothing is
 * archived automatically) — only new activations are refused.
 */
export const PRODUCTS_LIMIT_KEY = "products.max";

/** Where the limit comes from. Replaceable only by tests (the integration suite has no Platform to call). */
export const productLimitSource = {
  resolve: async (organizationId: string, requestId?: string): Promise<LimitDecision> =>
    readLimit(await fetchEntitlements(organizationId, requestId), PRODUCTS_LIMIT_KEY),
};

/** The limit, or a refusal (absent or invalid). Resolved before the transaction (a Platform call never holds a DB lock). */
export async function resolveProductLimit(organizationId: string, requestId?: string): Promise<number> {
  const decision = await productLimitSource.resolve(organizationId, requestId);
  if (decision.hasLimit) {
    if (!Number.isInteger(decision.max) || (decision.max as number) < 0) {
      throw new EntitlementRequiredError(`Invalid "${PRODUCTS_LIMIT_KEY}" entitlement`);
    }
    return decision.max as number;
  }
  if (decision.raw !== undefined && decision.raw !== null) throw new EntitlementRequiredError(`Invalid "${PRODUCTS_LIMIT_KEY}" entitlement`);
  throw new EntitlementRequiredError(`The plan sets no "${PRODUCTS_LIMIT_KEY}" — an absent limit is refused, never unlimited`);
}

/**
 * Inside the activating transaction: one organization's activations are serialized by an advisory lock, so
 * concurrent requests can never exceed the limit between the count and the insert/update.
 */
export async function assertProductCapacityInTx(tx: Tx, organizationId: string, max: number | null): Promise<void> {
  if (max === null) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`na-pista.products.active:${organizationId}`}, 0))`);
  const [row] = await tx
    .select({ n: count() })
    .from(products)
    .where(and(eq(products.organizationId, organizationId), eq(products.status, "ACTIVE")));
  if ((row?.n ?? 0) >= max) {
    throw new LimitExceededError(`The organization's plan allows at most ${max} active products`);
  }
}
