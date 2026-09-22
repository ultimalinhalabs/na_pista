import type { NextFunction, Request, Response } from "express";
import { decodeShapeOnly, isObviouslyExpired } from "../auth/jwt.js";
import { resolveIdentity } from "../platform/membership.js";
import { introspectServiceCredential } from "../platform/serviceIntrospection.js";
import { UnauthorizedError } from "../shared/errors.js";

function isApiKeyToken(token: string): boolean {
  return token.startsWith("ulk_");
}

function extractBearerToken(header: string | undefined): string {
  if (!header?.startsWith("Bearer ")) throw new UnauthorizedError("Missing bearer token");
  return header.slice("Bearer ".length).trim();
}

/**
 * The single place a request establishes "who/what is calling" — mirrors
 * ul-platform's own middleware/authenticate.ts posture: exactly one of
 * req.auth (human) or req.service (machine), never both, never neither on
 * success. Neither branch verifies a secret locally — both delegate to
 * the Platform (ADR-012/ADR-016).
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = extractBearerToken(req.header("authorization"));

    if (isApiKeyToken(token)) {
      req.service = await introspectServiceCredential(token, req.requestId);
      return next();
    }

    const shape = decodeShapeOnly(token);
    if (!shape || isObviouslyExpired(shape)) {
      throw new UnauthorizedError("Malformed or expired token");
    }

    const identity = await resolveIdentity(token, req.requestId);
    req.auth = { userId: identity.userId, email: identity.email };
    req.identity = identity;
    next();
  } catch (error) {
    next(error);
  }
}
