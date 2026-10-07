import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { db } from "../../db/index.js";
import { organizationPlatformCredentials, type OrganizationPlatformCredentialRow } from "../../db/schema/index.js";

/**
 * F29A: every query here is scoped by `organizationId` (ADR-021) — there is
 * no function that reads a credential row without one. Callers outside this
 * module never see `encryptedCredential`; only resolver.ts decrypts it.
 */
type Executor = Pick<typeof db, "select" | "insert" | "update">;

/**
 * The row that decides this organization's runtime state: its ACTIVE row if
 * one exists, otherwise its most recent row (REVOKED), otherwise none.
 * The partial unique index guarantees at most one ACTIVE row.
 */
export async function findCurrentCredential(
  organizationId: string,
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow | undefined> {
  const [active] = await executor
    .select()
    .from(organizationPlatformCredentials)
    .where(and(eq(organizationPlatformCredentials.organizationId, organizationId), eq(organizationPlatformCredentials.status, "ACTIVE")))
    .limit(1);
  if (active) return active;

  // D2-B — a PENDING row (received, possession not yet confirmed) never decides the runtime state.
  const [latest] = await executor
    .select()
    .from(organizationPlatformCredentials)
    .where(and(eq(organizationPlatformCredentials.organizationId, organizationId), ne(organizationPlatformCredentials.status, "PENDING")))
    .orderBy(desc(organizationPlatformCredentials.createdAt))
    .limit(1);
  return latest;
}

/** D2-B — every PENDING row (all organizations): the reconciler confirms these before asking for anything new. */
export async function listPendingCredentials(executor: Executor = db): Promise<OrganizationPlatformCredentialRow[]> {
  return executor.select().from(organizationPlatformCredentials).where(eq(organizationPlatformCredentials.status, "PENDING"));
}

/** D2-B — the organization's row(s) for one Platform provisioning request. */
export async function findByProvisioningRequest(
  organizationId: string,
  provisioningRequestId: string,
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow[]> {
  return executor
    .select()
    .from(organizationPlatformCredentials)
    .where(
      and(
        eq(organizationPlatformCredentials.organizationId, organizationId),
        eq(organizationPlatformCredentials.provisioningRequestId, provisioningRequestId),
      ),
    );
}

export async function insertPendingCredential(
  values: { organizationId: string; platformApiKeyId: string; encryptedCredential: string; provisioningRequestId: string },
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow> {
  const [row] = await executor
    .insert(organizationPlatformCredentials)
    .values({ ...values, status: "PENDING" })
    .returning();
  return row!;
}

/** D2-B — PENDING → ACTIVE for this organization's row of this exact Platform key. */
export async function activatePendingCredential(
  organizationId: string,
  platformApiKeyId: string,
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow | undefined> {
  const [row] = await executor
    .update(organizationPlatformCredentials)
    .set({ status: "ACTIVE", updatedAt: new Date() })
    .where(
      and(
        eq(organizationPlatformCredentials.organizationId, organizationId),
        eq(organizationPlatformCredentials.platformApiKeyId, platformApiKeyId),
        eq(organizationPlatformCredentials.status, "PENDING"),
      ),
    )
    .returning();
  return row;
}

/** D2-B — PENDING|ACTIVE → REVOKED for this organization's row of this exact Platform key (never reactivated). */
export async function revokeCredentialByPlatformKey(
  organizationId: string,
  platformApiKeyId: string,
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow | undefined> {
  const now = new Date();
  const [row] = await executor
    .update(organizationPlatformCredentials)
    .set({ status: "REVOKED", revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(organizationPlatformCredentials.organizationId, organizationId),
        eq(organizationPlatformCredentials.platformApiKeyId, platformApiKeyId),
        inArray(organizationPlatformCredentials.status, ["PENDING", "ACTIVE"]),
      ),
    )
    .returning();
  return row;
}

/** Any row (any status) of this organization backed by this Platform key. */
export async function findByPlatformKey(
  organizationId: string,
  platformApiKeyId: string,
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow | undefined> {
  const [row] = await executor
    .select()
    .from(organizationPlatformCredentials)
    .where(
      and(
        eq(organizationPlatformCredentials.organizationId, organizationId),
        eq(organizationPlatformCredentials.platformApiKeyId, platformApiKeyId),
      ),
    )
    .limit(1);
  return row;
}

export async function insertActiveCredential(
  values: { organizationId: string; platformApiKeyId: string; encryptedCredential: string },
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow> {
  const [row] = await executor
    .insert(organizationPlatformCredentials)
    .values({ ...values, status: "ACTIVE" })
    .returning();
  return row!;
}

/** ACTIVE → REVOKED for this organization. Returns the revoked row, or undefined if none was active. */
export async function revokeActiveCredential(
  organizationId: string,
  executor: Executor = db,
): Promise<OrganizationPlatformCredentialRow | undefined> {
  const now = new Date();
  const [row] = await executor
    .update(organizationPlatformCredentials)
    .set({ status: "REVOKED", revokedAt: now, updatedAt: now })
    .where(and(eq(organizationPlatformCredentials.organizationId, organizationId), eq(organizationPlatformCredentials.status, "ACTIVE")))
    .returning();
  return row;
}

/** Metadata only — the one shape that may ever leave the server boundary (never the secret, never the ciphertext). */
export interface PlatformCredentialStatus {
  configured: boolean;
  status: "ACTIVE" | "REVOKED" | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  revokedAt: Date | null;
}

export function toStatus(row: OrganizationPlatformCredentialRow | undefined): PlatformCredentialStatus {
  // D2-B — a PENDING row is not (yet) a configured credential: the public status contract stays ACTIVE | REVOKED | null.
  if (!row || row.status === "PENDING") return { configured: false, status: null, createdAt: null, updatedAt: null, revokedAt: null };
  return { configured: true, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, revokedAt: row.revokedAt };
}
