import type { PlatformIdentity } from "../platform/membership.js";
import type { ServiceIdentity } from "../platform/serviceIntrospection.js";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      /** Set for a human caller only — never together with `service`. */
      auth?: { userId: string; email?: string };
      identity?: PlatformIdentity;
      /** Set for a machine caller only — never together with `auth`. */
      service?: ServiceIdentity;
      /** Resolved tenant context — set only after requireTenantContext passes (human OR service path). */
      tenant?: { organizationId: string; actorType: "human" | "service"; roleKey?: string; scopes?: string[]; userId?: string };
    }
  }
}

export {};
