import { env } from "../config/env.js";
import { UpstreamUnavailableError } from "../shared/errors.js";

/**
 * The ONLY way this app talks to UL Platform: plain HTTP calls to its
 * public /v1 API — never a shared database connection, never an import of
 * Platform code (CLAUDE.md §2, ADR-001).
 *
 * Fail closed (ADR-017): a network error, timeout, or non-JSON response is
 * never treated as "Platform said no" — it surfaces as
 * UpstreamUnavailableError (503) and the caller must not fall back to
 * "allow". 8s default timeout: measured real round trips to this
 * environment's Platform (a remote Supabase Postgres pooler behind the
 * Platform's own queries) ranged up to ~6.5s on a cold connection — see
 * F19's docs/decisions.md.
 */
export interface PlatformResponse<T> {
  status: number;
  data?: T;
  error?: { code: string; message: string };
}

export async function callPlatform<T = unknown>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; timeoutMs?: number; requestId?: string } = {},
): Promise<PlatformResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${env.PLATFORM_API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.requestId ? { "x-request-id": opts.requestId } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const json = (await res.json().catch(() => undefined)) as { data?: T; error?: { code: string; message: string } } | undefined;
    return { status: res.status, data: json?.data, error: json?.error };
  } catch (error) {
    throw new UpstreamUnavailableError(
      `UL Platform unreachable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
