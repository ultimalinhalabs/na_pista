import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4200),
  PLATFORM_API_URL: z.string().url(),
  NA_PISTA_DATABASE_URL: z.string().min(1),
  NA_PISTA_DB_SCHEMA: z.string().min(1).default("na_pista"),
  NA_PISTA_ALLOWED_ORIGINS: z.string().min(1).default("http://localhost:3010"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = {
  ...parsed.data,
  NA_PISTA_ALLOWED_ORIGINS: parsed.data.NA_PISTA_ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean),
};
