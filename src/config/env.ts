import "dotenv/config";
import { z } from "zod";

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
    NA_PISTA_ALLOWED_ORIGINS: z.string().min(1).default("http://localhost:3010"),
    NA_PISTA_CREDENTIAL_ENCRYPTION_KEY: credentialKey,
    /**
     * Fase 6 (UL Platform): when "true", a human caller also needs the organization's UL
     * application access to NA_PISTA (GET /v1/me → memberships[].applications). Off by default:
     * existing organizations have no explicit access rows yet; turn on only after the access
     * backfill is authorized and applied.
     */
    NA_PISTA_REQUIRE_UL_APPLICATION_ACCESS: z.enum(["true", "false"]).default("false"),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.NA_PISTA_CREDENTIAL_ENCRYPTION_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["NA_PISTA_CREDENTIAL_ENCRYPTION_KEY"],
        message: "is required in production (Platform credentials are stored encrypted)",
      });
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
  NA_PISTA_ALLOWED_ORIGINS: parsed.data.NA_PISTA_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
};
