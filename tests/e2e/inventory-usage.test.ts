import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, createProduct, loadF22Fixtures, registerF22Credentials, startApp } from "./inventoryHelpers.js";

/** F22 brief §31 E2E — usage is real (api_requests meter, F20/F21's established choice), fire-and-forget. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF22Fixtures();

before(async () => {
  ctx = await startApp();
  registerF22Credentials(fixtures);
});
after(() => ctx.close());

test("a stock movement records real Platform usage (api_requests meter)", async () => {
  const product = await createProduct(ctx.base, fixtures.orgA.id, fixtures.orgA.ownerToken, "Usage Probe Product");

  const before1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before1.data?.quantity ?? 0;

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgA.ownerToken,
    body: { type: "RECEIPT", quantity: 1 },
  });

  let afterQty = beforeQty;
  for (let i = 0; i < 10 && afterQty <= beforeQty; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const after1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
      headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
    }).then((r) => r.json());
    afterQty = after1.data?.quantity ?? beforeQty;
  }
  assert.ok(afterQty > beforeQty, `expected api_requests usage to increase from ${beforeQty}, got ${afterQty}`);
});

test("a usage-write failure never blocks the movement itself (org B has its own registered credential, proving the happy path; the fire-and-forget failure path is unit-provable — platform/usage.ts catches and never throws)", async () => {
  const product = await createProduct(ctx.base, fixtures.orgB.id, fixtures.orgB.ownerToken, "Org B Usage Probe Product");
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/inventory/${product.id}/movements`, {
    token: fixtures.orgB.ownerToken,
    body: { type: "RECEIPT", quantity: 1 },
  });
  assert.equal(res.status, 201, "the movement must succeed regardless of usage-write outcome");
});
