import { fetchEntitlements, readLimit } from "../../platform/entitlements.js";
import { LimitExceededError, NotFoundError } from "../../shared/errors.js";
import { countActiveProducts, getProduct, insertProduct, listProducts, type TenantContext } from "./repository.js";

/** entitlements.md §4/§5: a *state* limit — compared against a live local count, never against Platform usage (PG-8). */
const PRODUCTS_MAX_KEY = "products.max";

/** Pure — unit tested directly without needing 1000 real rows to prove the boundary (entitlements.md's BUSINESS plan seeds products.max=1000). */
export function exceedsLimit(current: number, max: number): boolean {
  return current >= max;
}

export async function createProduct(tenant: TenantContext, requestId: string | undefined, input: { name: string }) {
  const resolved = await fetchEntitlements(tenant.organizationId, requestId);
  const limit = readLimit(resolved, PRODUCTS_MAX_KEY);

  if (limit.hasLimit && limit.max !== null) {
    const current = await countActiveProducts(tenant);
    if (exceedsLimit(current, limit.max)) {
      throw new LimitExceededError(`products.max (${limit.max}) reached for this organization`);
    }
  }

  return insertProduct(tenant, input);
}

export async function listAllProducts(tenant: TenantContext) {
  return listProducts(tenant);
}

export async function getProductOrThrow(tenant: TenantContext, id: string) {
  const product = await getProduct(tenant, id);
  if (!product) throw new NotFoundError("Product not found");
  return product;
}
