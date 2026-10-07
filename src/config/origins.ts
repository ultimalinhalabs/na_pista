/**
 * CORS allow-list parsing (runtime readiness). Browser origins only — server-to-server callers send no
 * Origin and are unaffected. Each entry must be an exact origin (scheme://host[:port], no path), never
 * "*"; in production every origin must be https and the list must be given explicitly (there is no
 * production default: the deployment configures it). Pure: returns the problems instead of throwing.
 */
export const DEVELOPMENT_DEFAULT_ORIGINS = "http://localhost:3010";

export function parseAllowedOrigins(raw: string, nodeEnv: string): { origins: string[]; problems: string[] } {
  const entries = raw.split(",").map((o) => o.trim()).filter(Boolean);
  const problems: string[] = [];
  if (entries.length === 0) problems.push("must list at least one origin");
  for (const entry of entries) {
    if (entry.includes("*")) {
      problems.push("wildcards are not allowed");
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      problems.push("every entry must be an origin like https://app.example");
      continue;
    }
    if (url.origin !== entry) problems.push("entries must be bare origins (scheme://host[:port], no path or trailing slash)");
    else if (url.protocol !== "https:" && url.protocol !== "http:") problems.push("only http(s) origins are allowed");
    else if (nodeEnv === "production" && url.protocol !== "https:") problems.push("production origins must use https");
  }
  return { origins: entries, problems: [...new Set(problems)] };
}
