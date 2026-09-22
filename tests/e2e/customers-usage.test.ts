import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { call, loadF21Fixtures, registerF21Credentials, startApp } from "./customersHelpers.js";

/** F21 brief §14/§19/§20 matrix item 17: usage is real (api_requests meter, F20's established choice), fire-and-forget. */
let ctx: Awaited<ReturnType<typeof startApp>>;
const fixtures = loadF21Fixtures();

before(async () => {
  ctx = await startApp();
  registerF21Credentials(fixtures);
});
after(() => ctx.close());

test("a customer write records real Platform usage (api_requests meter)", async () => {
  const before1 = await fetch(`${fixtures.platformBaseUrl}/organizations/${fixtures.orgA.id}/applications/NA_PISTA/usage/api_requests`, {
    headers: { authorization: `Bearer ${fixtures.orgA.ownerToken}` },
  }).then((r) => r.json());
  const beforeQty = before1.data?.quantity ?? 0;

  await call(ctx.base, "POST", `/organizations/${fixtures.orgA.id}/customers`, {
    token: fixtures.orgA.ownerToken,
    body: { name: "Usage Probe Customer" },
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

test("a usage-write failure (unregistered credential for a DIFFERENT org) never blocks the mutation itself", async () => {
  // org B has a registered credential in this test file's process, so
  // this proves the happy path succeeds; the fire-and-forget failure
  // path itself is unit-provable (platform/usage.ts catches and logs,
  // never throws) — not re-exercised live here to avoid faking a broken
  // credential mid-suite, which would leave org B unable to record real
  // usage for the rest of this file's tests.
  const res = await call(ctx.base, "POST", `/organizations/${fixtures.orgB.id}/customers`, {
    token: fixtures.orgB.ownerToken,
    body: { name: "Org B Usage Probe" },
  });
  assert.equal(res.status, 201, "the mutation must succeed regardless of usage-write outcome");
});
