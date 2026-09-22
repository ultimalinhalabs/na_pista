import type { Request } from "express";
import { UnauthorizedError } from "../shared/errors.js";

export interface Actor {
  type: "user" | "service";
  id: string;
}

/** Who actually performed the mutation — for audit (never derived from client-supplied input). */
export function actorFromRequest(req: Request): Actor {
  if (req.tenant?.actorType === "human" && req.tenant.userId) {
    return { type: "user", id: req.tenant.userId };
  }
  if (req.tenant?.actorType === "service" && req.service) {
    return { type: "service", id: req.service.apiKeyId };
  }
  throw new UnauthorizedError();
}
