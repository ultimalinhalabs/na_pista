import { ZodError, type ZodType } from "zod";
import { ValidationError, type ValidationIssue } from "./errors.js";

/** ADR-053: flattens Zod issues into the public `details` shape — field path and message only, never the rejected value. */
export function toValidationIssues(error: ZodError, location?: ValidationIssue["location"]): ValidationIssue[] {
  return error.issues.map((issue) => {
    const keys = issue.code === "unrecognized_keys" ? (issue as { keys?: string[] }).keys : undefined;
    const path = [...issue.path.map(String), ...(keys && keys.length === 1 ? keys : [])].join(".");
    return { ...(location ? { location } : {}), path, message: issue.message };
  });
}

function parseAt<T>(schema: ZodType<T>, input: unknown, location: ValidationIssue["location"]): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ValidationError("Invalid request payload", toValidationIssues(result.error, location));
  return result.data;
}

/** Validates a JSON request body against an existing module schema. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  return parseAt(schema, body, "body");
}

/** Validates the query string against an existing module schema. */
export function parseQuery<T>(schema: ZodType<T>, query: unknown): T {
  return parseAt(schema, query, "query");
}
