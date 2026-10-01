import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request } from "express";
import { roleHasPermission } from "../../src/authorization/permissions.js";
import { requireHumanPermission } from "../../src/middleware/requireAuthorized.js";
import { ForbiddenError, UnauthorizedError } from "../../src/shared/errors.js";

/** ADR-055/056 — integration/governance reads: OWNER/ADMIN humans only; never a service credential. */
function run(permission: string, tenant: Request["tenant"]) {
  let result: unknown = "not-called";
  requireHumanPermission(permission)({ tenant } as Request, {} as never, (err?: unknown) => {
    result = err ?? "next";
  });
  return result;
}

for (const permission of ["audit.read", "integrations.read"]) {
  test(`${permission}: OWNER and ADMIN only`, () => {
    for (const role of ["OWNER", "ADMIN"]) {
      assert.equal(roleHasPermission(role, permission), true);
      assert.equal(run(permission, { organizationId: "o", actorType: "human", roleKey: role }), "next");
    }
    for (const role of ["MANAGER", "STAFF", "UNKNOWN"]) {
      assert.equal(roleHasPermission(role, permission), false);
      assert.ok(run(permission, { organizationId: "o", actorType: "human", roleKey: role }) instanceof ForbiddenError);
    }
  });

  test(`${permission}: a service credential is refused whatever its scopes`, () => {
    const r = run(permission, { organizationId: "o", actorType: "service", scopes: ["catalog.read", "catalog.write", "usage.write", "event.publish"] });
    assert.ok(r instanceof ForbiddenError);
  });
}

test("no tenant context -> 401", () => {
  assert.ok(run("audit.read", undefined) instanceof UnauthorizedError);
});
