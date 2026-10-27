import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { idempotencyKeys } from "../../db/schema/index.js";
import { IdempotencyKeyRequiredError, IdempotencyKeyReusedError, ValidationError } from "../../shared/errors.js";

/**
 * ADR-073 — Idempotency-Key for the creating endpoints a retry could duplicate (orders, customers, stock
 * movements). The key row is written in the SAME transaction as the business fact; a concurrent request with the
 * same key waits on the unique index and then replays. Required for service credentials (external interfaces),
 * optional for humans (the Console). Nothing is called outside Na Pista's own database.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface IdempotencyRequest {
  key: string;
  operation: string;
  requestHash: string;
}

const KEY_PATTERN = /^[\x21-\x7E]{1,200}$/;

/** Stable JSON (sorted keys) so the same request always hashes the same, whatever the client's key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashRequest(operation: string, payload: unknown): string {
  return createHash("sha256").update(`${operation}\n${canonical(payload)}`).digest("hex");
}

/** Reads and validates the header. `payload` = path parameters + the VALIDATED body (normalized by the schema). */
export function idempotencyFor(req: Request, operation: string, payload: unknown): IdempotencyRequest | undefined {
  const raw = req.header("idempotency-key");
  if (raw === undefined || raw === "") {
    if (req.tenant?.actorType === "service") throw new IdempotencyKeyRequiredError();
    return undefined;
  }
  const key = raw.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError("Invalid Idempotency-Key header", [{ location: "header", path: "Idempotency-Key", message: "1 to 200 visible ASCII characters" }]);
  }
  return { key, operation, requestHash: hashRequest(operation, payload) };
}

/**
 * Runs `execute` in one transaction. With a key: claims it first (unique per organization + actor + key); a key
 * already bound to the same request replays `replay(resourceId)` without writing anything; bound to a different
 * request → 409 IDEMPOTENCY_KEY_REUSED. A failed `execute` rolls the claim back with everything else.
 */
export async function runIdempotent<T>(
  scope: { organizationId: string; actor: { type: "user" | "service"; id: string } },
  idempotency: IdempotencyRequest | undefined,
  execute: (tx: Tx) => Promise<T>,
  resourceIdOf: (result: T) => string,
  replay: (resourceId: string) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!idempotency) return { result: await db.transaction(execute), replayed: false };

  const outcome = await db.transaction(async (tx): Promise<{ result: T } | { replayId: string }> => {
    const [claimed] = await tx
      .insert(idempotencyKeys)
      .values({
        organizationId: scope.organizationId,
        actorType: scope.actor.type,
        actorId: scope.actor.id,
        idempotencyKey: idempotency.key,
        operation: idempotency.operation,
        requestHash: idempotency.requestHash,
      })
      .onConflictDoNothing({ target: [idempotencyKeys.organizationId, idempotencyKeys.actorType, idempotencyKeys.actorId, idempotencyKeys.idempotencyKey] })
      .returning({ id: idempotencyKeys.id });

    if (!claimed) {
      const [existing] = await tx
        .select({ requestHash: idempotencyKeys.requestHash, resourceId: idempotencyKeys.resourceId })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.organizationId, scope.organizationId),
            eq(idempotencyKeys.actorType, scope.actor.type),
            eq(idempotencyKeys.actorId, scope.actor.id),
            eq(idempotencyKeys.idempotencyKey, idempotency.key),
          ),
        );
      if (!existing || existing.requestHash !== idempotency.requestHash || !existing.resourceId) throw new IdempotencyKeyReusedError();
      return { replayId: existing.resourceId };
    }

    const result = await execute(tx);
    await tx.update(idempotencyKeys).set({ resourceId: resourceIdOf(result) }).where(eq(idempotencyKeys.id, claimed.id));
    return { result };
  });

  if ("replayId" in outcome) return { result: await replay(outcome.replayId), replayed: true };
  return { result: outcome.result, replayed: false };
}
