import { sql } from "drizzle-orm";
import { check, index, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { naPistaSchema } from "./categories.js";
import { timestamps } from "./_helpers.js";

/**
 * F29A: each Organization's platform-facing UL Platform credential (the
 * organization-scoped NA_PISTA API key Na Pista uses for its OWN outbound
 * calls — entitlements, usage), persisted so a restarted process keeps
 * serving every tenant. Replaces the in-memory registry as the runtime
 * source (src/platform/serviceAuth.ts is now a non-production test override).
 *
 * - `encrypted_credential`: a `v1:` AES-256-GCM envelope
 *   (src/security/credentialCrypto.ts) whose AAD binds it to
 *   `organization_id` — plaintext is never stored, and a ciphertext moved
 *   to another organization's row cannot be decrypted.
 * - `platform_api_key_id`: the Platform's own public key id (from
 *   `GET /v1/service/me` introspection at provisioning). Not secret — the
 *   Platform documents it as safe to expose — and UNIQUE, so one Platform
 *   key can never back two rows or two organizations.
 * - `status` reuses the Platform's own `api_keys` vocabulary
 *   (ACTIVE/REVOKED). A REVOKED row is kept (history, audit correlation)
 *   and is never reactivated.
 *
 * No environment column: Platform API keys have no environment dimension,
 * and each Na Pista deployment has its own database. No organizations
 * table exists in Na Pista to reference (identity lives in the Platform,
 * ADR-002) — tenant ownership is `organization_id NOT NULL` + the partial
 * unique index + the AAD binding above.
 */
export const organizationPlatformCredentials = naPistaSchema.table(
  "organization_platform_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    platformApiKeyId: uuid("platform_api_key_id").notNull(),
    encryptedCredential: text("encrypted_credential").notNull(),
    // D2-B — PENDING: a managed credential received from the Platform and stored (encrypted) BEFORE its
    // possession is confirmed there. The resolver never uses a PENDING row.
    status: text("status", { enum: ["PENDING", "ACTIVE", "REVOKED"] }).notNull().default("ACTIVE"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** D2-B — the Platform provisioning request that issued this credential (null for credentials provisioned by hand, F29A). */
    provisioningRequestId: uuid("provisioning_request_id"),
    ...timestamps,
  },
  (table) => [
    // At most ONE active credential per organization — the runtime can never
    // have to choose between two, and a concurrent double-provision loses here.
    uniqueIndex("org_platform_credentials_one_active_per_org")
      .on(table.organizationId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // D2-B — and at most one PENDING (a re-key keeps the ACTIVE one serving while the new one is confirmed).
    uniqueIndex("org_platform_credentials_one_pending_per_org")
      .on(table.organizationId)
      .where(sql`${table.status} = 'PENDING'`),
    uniqueIndex("org_platform_credentials_platform_api_key_id_unique").on(table.platformApiKeyId),
    index("org_platform_credentials_org_created_idx").on(table.organizationId, table.createdAt),
    check("org_platform_credentials_status_valid", sql`${table.status} IN ('PENDING', 'ACTIVE', 'REVOKED')`),
    check("org_platform_credentials_pending_has_request", sql`${table.status} <> 'PENDING' OR ${table.provisioningRequestId} IS NOT NULL`),
    check("org_platform_credentials_revoked_at_matches_status", sql`(${table.status} = 'REVOKED') = (${table.revokedAt} IS NOT NULL)`),
    check("org_platform_credentials_envelope_versioned", sql`${table.encryptedCredential} LIKE 'v1:%'`),
  ],
);

export type OrganizationPlatformCredentialRow = typeof organizationPlatformCredentials.$inferSelect;
