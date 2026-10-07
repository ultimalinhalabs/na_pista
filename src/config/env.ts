import "dotenv/config";
import { z } from "zod";
import { isLocalHostname, isTestRun } from "../db/testDatabaseGuard.js";
import { DEVELOPMENT_DEFAULT_ORIGINS, parseAllowedOrigins } from "./origins.js";

/**
 * F29A: key for Platform credentials at rest (AES-256-GCM, base64 of exactly
 * 32 bytes — generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
 * Dedicated to Na Pista: never another service's key (e.g. UL Platform's
 * WEBHOOK_SECRET_ENCRYPTION_KEY), never hardcoded.
 *  - malformed → startup fails in every environment;
 *  - missing   → startup fails in production (fail closed); in development/test
 *                the app starts, and every credential encrypt/decrypt fails
 *                closed at use time instead.
 */
const credentialKey = z.preprocess(
  // An empty `NA_PISTA_CREDENTIAL_ENCRYPTION_KEY=` (as copied from .env.example) means "not set".
  (v) => (v === "" ? undefined : v),
  z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be base64 decoding to exactly 32 bytes")
    .optional(),
);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4200),
    PLATFORM_API_URL: z.string().url(),
    NA_PISTA_DATABASE_URL: z.string().min(1),
    NA_PISTA_DB_SCHEMA: z.string().min(1).default("na_pista"),
    /**
     * Browser origins allowed by CORS (comma-separated exact origins). REQUIRED in production (no
     * default, https only, never "*"); development/test fall back to the local Default UI.
     */
    NA_PISTA_ALLOWED_ORIGINS: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
    NA_PISTA_CREDENTIAL_ENCRYPTION_KEY: credentialKey,
    /**
     * Fase 6 (UL Platform): when "true", a human caller also needs the organization's UL
     * application access to NA_PISTA (GET /v1/me → memberships[].applications).
     * D2-B: in production the check is ALWAYS enforced (tenancy/tenantContext.ts) — this variable
     * can only relax it for local/test harnesses, never for a real deployment.
     */
    NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS: z.enum(["true", "false"]).default("false"),
    /**
     * D2-B: the Platform PROVISIONER credential (PLATFORM_SERVICE, purpose PROVISIONER, scope
     * `credential.provision`) the reconciler uses to pull managed credentials. Unset → no reconciler.
     * A deployment secret: never in a file, a log or the repository.
     */
    NA_PISTA_PROVISIONING_CREDENTIAL: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().startsWith("ulk_").optional(),
    ),
    NA_PISTA_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1_000).default(30_000),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.NA_PISTA_CREDENTIAL_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["NA_PISTA_CREDENTIAL_ENCRYPTION_KEY"],
        message: "is required in production (Platform credentials are stored encrypted)",
      });
    }
    // CORS: an explicit, valid allow-list in production; the local default only outside production.
    if (value.NODE_ENV === "production" && !value.NA_PISTA_ALLOWED_ORIGINS) {
      ctx.addIssue({ code: "custom", path: ["NA_PISTA_ALLOWED_ORIGINS"], message: "is required in production (no default origin)" });
    } else {
      const { problems } = parseAllowedOrigins(value.NA_PISTA_ALLOWED_ORIGINS ?? DEVELOPMENT_DEFAULT_ORIGINS, value.NODE_ENV);
      for (const problem of problems) ctx.addIssue({ code: "custom", path: ["NA_PISTA_ALLOWED_ORIGINS"], message: problem });
    }
    // Database separation: outside production the runtime only ever talks to a LOCAL database. (Under
    // the test runner the stricter test-database guard in db/index.ts applies.) Fail closed, no override.
    if (value.NODE_ENV !== "production" && !isTestRun()) {
      let host: string | undefined;
      try {
        host = new URL(value.NA_PISTA_DATABASE_URL).hostname;
      } catch {
        host = undefined;
      }
      if (!host || !isLocalHostname(host)) {
        ctx.addIssue({
          code: "custom",
          path: ["NA_PISTA_DATABASE_URL"],
          message: "must be a local (loopback) database outside production — the production database is only configured in the deployment",
        });
      }
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Field names and messages only — flatten() never includes the values.
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = {
  ...parsed.data,
  NA_PISTA_ALLOWED_ORIGINS: parseAllowedOrigins(parsed.data.NA_PISTA_ALLOWED_ORIGINS ?? DEVELOPMENT_DEFAULT_ORIGINS, parsed.data.NODE_ENV).origins,
};
