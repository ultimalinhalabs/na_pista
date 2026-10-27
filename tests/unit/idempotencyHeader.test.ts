import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import { idempotencyFor } from "../../src/modules/idempotency/service.js";
import { IdempotencyKeyRequiredError, ValidationError } from "../../src/shared/errors.js";

/** ADR-073 — the header contract (no database): required for service credentials, optional for users, bounded. */
const req = (actorType: "human" | "service", key?: string) =>
  ({ tenant: { organizationId: "o", actorType }, header: (name: string) => (name.toLowerCase() === "idempotency-key" ? key : undefined) }) as unknown as Request;

test("a service credential without Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED", () => {
  assert.throws(() => idempotencyFor(req("service"), "orders.create", {}), (e: unknown) => e instanceof IdempotencyKeyRequiredError && e.statusCode === 400);
  assert.throws(() => idempotencyFor(req("service", ""), "orders.create", {}), IdempotencyKeyRequiredError);
});

test("a user without the header → no idempotency (the Console keeps working unchanged)", () => {
  assert.equal(idempotencyFor(req("human"), "orders.create", {}), undefined);
});

test("valid keys are accepted (trimmed); the request hash is bound to the operation and payload", () => {
  const a = idempotencyFor(req("service", "  order-2026-10-27-0001 "), "orders.create", { body: { x: 1 } });
  assert.equal(a?.key, "order-2026-10-27-0001");
  assert.equal(a?.operation, "orders.create");
  assert.match(a!.requestHash, /^[0-9a-f]{64}$/);
  assert.equal(idempotencyFor(req("human", "k"), "orders.create", { body: { x: 1 } })?.requestHash, a!.requestHash);
});

test("malformed keys → 400 VALIDATION_ERROR on the header (too long, spaces or control characters, non-ASCII)", () => {
  for (const bad of ["x".repeat(201), "two words", "tab\there", "chave-ção"]) {
    assert.throws(
      () => idempotencyFor(req("service", bad), "orders.create", {}),
      (e: unknown) => e instanceof ValidationError && (e.details?.[0] as { location?: string })?.location === "header",
      bad,
    );
  }
});
