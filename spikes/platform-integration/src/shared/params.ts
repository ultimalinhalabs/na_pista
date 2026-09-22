export function paramString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
