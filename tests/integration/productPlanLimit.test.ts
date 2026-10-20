import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, mock } from "node:test";
import { and, count, eq } from "drizzle-orm";
import { db, queryClient } from "../../src/db/index.js";
import { products } from "../../src/db/schema/index.js";
import type { LimitDecision } from "../../src/platform/entitlements.js";
import { productLimitSource, resolveProductLimit } from "../../src/modules/products/planLimit.js";
import { archiveProduct, createProduct, updateProductOrThrow } from "../../src/modules/products/service.js";
import { EntitlementRequiredError, LimitExceededError } from "../../src/shared/errors.js";

/**
 * The plan's `products.max` (UL Platform entitlement) enforced by Na Pista's server on real PostgreSQL:
 * creation and reactivation count, archiving never does, concurrency cannot overshoot, a downgrade keeps
 * what exists, and an invalid entitlement fails closed. The Platform answer is replaced via
 * `productLimitSource` (this suite has no Platform to call).
 */
after(() => queryClient.end());

const actor = { type: "user" as const, id: "plan-limit-test" };
const newOrg = () => ({ organizationId: randomUUID() });
const limit = (max: number | null, raw: unknown = max): LimitDecision => (max === null ? { hasLimit: false, max: null, raw } : { hasLimit: true, max, raw: max });
function planAllows(decision: LimitDecision) {
  mock.method(productLimitSource, "resolve", async () => decision);
}
async function activeCount(org: { organizationId: string }) {
  const [r] = await db.select({ n: count() }).from(products).where(and(eq(products.organizationId, org.organizationId), eq(products.status, "ACTIVE")));
  return r!.n;
}
const create = (org: { organizationId: string }, name: string) => createProduct(org, actor, undefined, { name });

test("resolveProductLimit: a number is the limit; absence and anything else are refused (absent policy deny)", async (t) => {
  t.after(() => mock.restoreAll());
  planAllows(limit(500));
  assert.equal(await resolveProductLimit(randomUUID()), 500);
  planAllows(limit(0));
  assert.equal(await resolveProductLimit(randomUUID()), 0);
  planAllows(limit(null, undefined));
  await assert.rejects(() => resolveProductLimit(randomUUID()), EntitlementRequiredError, "the plan sets no products.max — never unlimited");
  planAllows({ hasLimit: false, max: null, raw: null });
  await assert.rejects(() => resolveProductLimit(randomUUID()), EntitlementRequiredError, "no subscription");
  for (const bad of [{ hasLimit: false, max: null, raw: "500" }, { hasLimit: true, max: 2.5, raw: 2.5 }, { hasLimit: true, max: -1, raw: -1 }] as LimitDecision[]) {
    planAllows(bad);
    await assert.rejects(() => resolveProductLimit(randomUUID()), EntitlementRequiredError);
  }
});

test("creation stops at the plan's limit (409 LIMIT_EXCEEDED); archiving frees a slot", async (t) => {
  t.after(() => mock.restoreAll());
  planAllows(limit(2));
  const org = newOrg();
  const a = await create(org, "A");
  await create(org, "B");
  await assert.rejects(() => create(org, "C"), (e: unknown) => e instanceof LimitExceededError && /at most 2 active products/.test((e as Error).message));
  assert.equal(await activeCount(org), 2, "nothing half-created");
  await archiveProduct(org, actor, undefined, a.id);
  await create(org, "C");
  assert.equal(await activeCount(org), 2);
});

test("reactivating an archived product counts like a creation; other updates never do", async (t) => {
  t.after(() => mock.restoreAll());
  planAllows(limit(1));
  const org = newOrg();
  const a = await create(org, "A");
  await archiveProduct(org, actor, undefined, a.id);
  const b = await create(org, "B");
  await assert.rejects(() => updateProductOrThrow(org, actor, undefined, a.id, { status: "ACTIVE" }), LimitExceededError);
  await updateProductOrThrow(org, actor, undefined, b.id, { name: "B renamed", status: "ACTIVE" }); // already active: no new slot
  await updateProductOrThrow(org, actor, undefined, a.id, { name: "A renamed while archived" });
  await archiveProduct(org, actor, undefined, b.id);
  await updateProductOrThrow(org, actor, undefined, a.id, { status: "ACTIVE" });
  assert.equal(await activeCount(org), 1);
});

test("concurrent creations can never overshoot the limit", async (t) => {
  t.after(() => mock.restoreAll());
  planAllows(limit(3));
  const org = newOrg();
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => create(org, `P${i}`)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof LimitExceededError));
  assert.equal(await activeCount(org), 3);
});

test("plan change: a downgrade below the current count keeps existing products and refuses new ones; an upgrade allows them again", async (t) => {
  t.after(() => mock.restoreAll());
  const org = newOrg();
  planAllows(limit(5));
  for (const n of ["A", "B", "C", "D"]) await create(org, n);
  planAllows(limit(2));
  await assert.rejects(() => create(org, "E"), LimitExceededError);
  assert.equal(await activeCount(org), 4, "nothing archived automatically");
  planAllows(limit(500));
  await create(org, "E");
  assert.equal(await activeCount(org), 5);
});

test("a plan without products.max refuses creation (absent ≠ unlimited); the limit is per organization", async (t) => {
  t.after(() => mock.restoreAll());
  planAllows(limit(null, undefined));
  const noLimit = newOrg();
  await assert.rejects(() => create(noLimit, "U0"), EntitlementRequiredError);
  assert.equal(await activeCount(noLimit), 0);
  planAllows(limit(1));
  const a = newOrg();
  const b = newOrg();
  await create(a, "A1");
  await create(b, "B1");
  await assert.rejects(() => create(a, "A2"), LimitExceededError);
});
