import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4100),
  PLATFORM_API_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  NA_PISTA_DATABASE_URL: z.string().min(1),
  NA_PISTA_DB_SCHEMA: z.string().min(1).default("na_pista_spike"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid spike environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration");
}

export const env = parsed.data;
