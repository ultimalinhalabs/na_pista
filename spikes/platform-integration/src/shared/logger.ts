/**
 * Structured, secret-free logging (docs/integration-flow.md §5 /
 * F19 brief §21). Never logs a JWT, API secret, or DATABASE_URL — only
 * identifiers and outcome fields.
 */
type Fields = Record<string, string | number | boolean | null | undefined>;

function line(level: "info" | "warn" | "error", event: string, fields: Fields) {
  console.log(JSON.stringify({ level, event, ...fields, ts: new Date().toISOString() }));
}

export const logger = {
  info: (event: string, fields: Fields = {}) => line("info", event, fields),
  warn: (event: string, fields: Fields = {}) => line("warn", event, fields),
  error: (event: string, fields: Fields = {}) => line("error", event, fields),
};
