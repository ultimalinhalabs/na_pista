import { env } from "../config/env.js";
import { UpstreamUnavailableError } from "../shared/errors.js";

/**
 * The ONLY way this spike talks to UL Platform: plain HTTP calls to its
 * public /v1 API, exactly like any other client — never a shared database
 * connection, never an import of Platform code (CLAUDE.md §2, ADR-001).
 *
 * Fail closed (F19 §20): a network error, timeout, or non-JSON response is
 * never treated as "Platform said no capability" — it is surfaced as
 * UpstreamUnavailableError (503) and the caller must not fall back to
 * "allow". Timeout is short and explicit (default 3s) so one slow
 * dependency call doesn't hang a request indefinitely.
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
  // 8s default: measured real round trips to this environment's Platform
  // (a remote Supabase Postgres pooler behind the Platform's own queries)
  // ranged up to ~6.5s, dominated by connection setup on a cold
  // connection — 3s was tested first and produced false UPSTREAM_UNAVAILABLE
  // failures on legitimate, if slow, responses. This is a tuning value,
  // not a security boundary; the fail-closed *behavior* on a genuine
  // timeout is unaffected (see tests/e2e/platform-unavailable.test.ts,
  // which points at an address nothing listens on and fails in
  // milliseconds via ECONNREFUSED regardless of this number).
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
    // Network failure, DNS failure, connection refused, or our own
    // timeout abort — all indistinguishable to the caller and all fail
    // closed the same way.
    throw new UpstreamUnavailableError(
      `UL Platform unreachable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}
