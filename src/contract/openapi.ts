import { z } from "zod";
import { operations, type Operation } from "./operations.js";
import * as contract from "./schemas.js";

/**
 * ADR-054: builds the OpenAPI 3.1 document from the operation registry and
 * the Zod schemas — the same schemas that validate requests at runtime and
 * real responses in tests. No hand-written second description.
 */
type Json = Record<string, unknown>;

const API_VERSION = "1.0.0";

const DESCRIPTION = `Na Pista — operational infrastructure for businesses (catalogue, stock, orders, services,
professionals, scheduling, appointments), part of the Última Linha ecosystem.

**Authentication:** \`Authorization: Bearer <token>\` — either a UL Platform user access token (Supabase Auth JWT)
or a UL Platform service credential (\`ulk_…\`). See docs/api/authentication.md.

**Tenancy:** every business route is under \`/organizations/{organizationId}\`; the caller must be an active member
(human) or hold a credential issued for that organization (service).

**Envelope:** success \`{ "data": … }\` (paginated lists add \`pagination\`); error
\`{ "error": { "code", "message", "details"? } }\`. Clients must ignore unknown response fields.

**Authorization extensions:** \`x-na-pista-permission\` (human role permission), \`x-na-pista-scope\` (service
credential scope; absent = humans only), \`x-na-pista-capability\` (organization entitlement required).`;

/** Zod emits a full regex next to `format: uuid|date-time|email`; the format already says it — keep only meaningful patterns. */
const FORMATS_WITH_REDUNDANT_PATTERN = new Set(["uuid", "date-time", "email"]);
function dropRedundantPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropRedundantPatterns);
  if (value && typeof value === "object") {
    const out: Json = {};
    const fmt = (value as Json).format;
    for (const [k, v] of Object.entries(value)) {
      if (k === "pattern" && typeof fmt === "string" && FORMATS_WITH_REDUNDANT_PATTERN.has(fmt)) continue;
      out[k] = dropRedundantPatterns(v);
    }
    return out;
  }
  return value;
}

function stripMeta(schema: Json): Json {
  const { $schema: _s, $id: _i, ...rest } = schema;
  return dropRedundantPatterns(rest) as Json;
}

/** Response components: tolerate additive fields (ADR-054) — drop `additionalProperties: false` recursively. */
function relax(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(relax);
  if (value && typeof value === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "additionalProperties" && v === false) continue;
      out[k] = relax(v);
    }
    return out;
  }
  return value;
}

/** Named response schemas = every Zod schema exported by contract/schemas.ts that carries a meta id. */
function responseComponents(): { schemas: Record<string, Json>; idOf: Map<z.ZodType, string> } {
  const registry = z.registry<{ id: string; description?: string }>();
  const idOf = new Map<z.ZodType, string>();
  for (const value of Object.values(contract)) {
    if (!(value instanceof z.ZodType)) continue;
    const meta = z.globalRegistry.get(value) as { id?: string; description?: string } | undefined;
    if (!meta?.id) continue;
    registry.add(value, { ...meta, id: meta.id });
    idOf.set(value, meta.id);
  }
  const out = z.toJSONSchema(registry, {
    target: "draft-2020-12",
    io: "output",
    uri: (id) => `#/components/schemas/${id}`,
  }) as { schemas: Record<string, Json> };
  const schemas: Record<string, Json> = {};
  for (const [id, schema] of Object.entries(out.schemas)) schemas[id] = relax(stripMeta(schema)) as Json;
  return { schemas, idOf };
}

function inputSchema(schema: z.ZodType): Json {
  return stripMeta(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Json);
}

const ref = (id: string) => ({ $ref: `#/components/schemas/${id}` });

function toOpenApiPath(path: string) {
  return path.replace(/:(\w+)/g, "{$1}");
}

function pathParameters(path: string) {
  return [...path.matchAll(/:(\w+)/g)].map(([, name]) => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", format: "uuid" },
  }));
}

function queryParameters(query: z.ZodObject) {
  const json = inputSchema(query) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, schema]) => {
    const { description, ...rest } = schema as Json & { description?: string };
    return {
      name,
      in: "query",
      required: (json.required ?? []).includes(name) && !("default" in rest),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

function successResponse(op: Operation, idOf: Map<z.ZodType, string>) {
  const id = idOf.get(op.success.schema);
  if (!id) throw new Error(`Response schema for ${op.method.toUpperCase()} ${op.path} has no meta id`);
  const one = op.success.nullable ? { anyOf: [ref(id), { type: "null" }] } : ref(id);
  let schema: Json;
  switch (op.success.kind) {
    case "data":
      schema = { type: "object", required: ["data"], properties: { data: one } };
      break;
    case "list":
      schema = { type: "object", required: ["data"], properties: { data: { type: "array", items: ref(id) } } };
      break;
    case "page":
      schema = {
        type: "object",
        required: ["data", "pagination"],
        properties: { data: { type: "array", items: ref(id) }, pagination: ref("Pagination") },
      };
      break;
    case "raw":
      schema = ref(id);
      break;
  }
  return {
    [String(op.success.status)]: {
      description: op.success.status === 201 ? "Created" : "OK",
      content: { "application/json": { schema } },
    },
  };
}

function errorResponse(description: string, codes: string[]) {
  return {
    description: codes.length ? `${description} Codes: ${codes.map((c) => `\`${c}\``).join(", ")}.` : description,
    content: { "application/json": { schema: ref("ErrorResponse") } },
  };
}

function errorResponses(op: Operation) {
  if (op.auth === "public") return {};
  const hasInput = Boolean(op.query || op.body || /:\w+/.test(op.path));
  const isMutation = op.method !== "get";
  const hasResource = /:(?!organizationId)\w+/.test(op.path);
  const gate = op.auth.capabilityGate !== false;
  const out: Record<string, unknown> = {};
  if (hasInput) out["400"] = errorResponse("Invalid input (see `error.details`).", ["VALIDATION_ERROR", ...(op.badRequest ?? [])]);
  out["401"] = errorResponse("Missing, malformed, expired or rejected credentials.", ["UNAUTHORIZED"]);
  out["403"] = errorResponse(
    "Not a member of / not scoped to this organization, missing permission or scope" + (gate ? ", or capability not enabled." : "."),
    ["FORBIDDEN", ...(gate ? ["ENTITLEMENT_REQUIRED"] : [])],
  );
  if (hasResource || op.notFound?.length) out["404"] = errorResponse("Not found in this organization.", ["NOT_FOUND", ...(op.notFound ?? [])]);
  if (isMutation || op.conflicts?.length) out["409"] = errorResponse("Conflicts with the current state.", ["CONFLICT", ...(op.conflicts ?? [])]);
  if (op.body) out["413"] = errorResponse("Request body too large.", ["PAYLOAD_TOO_LARGE"]);
  out["503"] = errorResponse("A required dependency (UL Platform or Na Pista's database) is unavailable. Retry later.", ["UPSTREAM_UNAVAILABLE"]);
  out["500"] = errorResponse("Unexpected error. Report the X-Request-ID.", ["INTERNAL_ERROR"]);
  return out;
}

function operationObject(op: Operation, idOf: Map<z.ZodType, string>) {
  const parameters = [...pathParameters(op.path), ...(op.query ? queryParameters(op.query) : [])];
  const auth = op.auth;
  const permission = auth === "public" ? undefined : auth.permission;
  return {
    operationId: `${op.method}${op.path
      .replace(/:(\w+)/g, "By-$1")
      .split(/[/-]/)
      .filter(Boolean)
      .map((p) => p[0]!.toUpperCase() + p.slice(1))
      .join("")}`,
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(auth === "public" ? { security: [] } : {}),
    ...(permission ? { "x-na-pista-permission": permission } : {}),
    ...(auth !== "public" && auth.scope ? { "x-na-pista-scope": auth.scope } : {}),
    ...(auth !== "public" && auth.capabilityGate !== false ? { "x-na-pista-capability": "catalog.enabled" } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(op.body
      ? { requestBody: { required: true, content: { "application/json": { schema: inputSchema(op.body) } } } }
      : {}),
    responses: { ...successResponse(op, idOf), ...errorResponses(op) },
  };
}

export function buildOpenApiDocument() {
  const { schemas, idOf } = responseComponents();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    const key = toOpenApiPath(op.path);
    paths[key] ??= {};
    paths[key][op.method] = operationObject(op, idOf);
  }
  const tags = [...new Set(operations.map((op) => op.tag))].map((name) => ({ name }));
  return {
    openapi: "3.1.0",
    info: { title: "Na Pista API", version: API_VERSION, description: DESCRIPTION },
    servers: [{ url: "/v1", description: "Relative to the Na Pista API host." }],
    security: [{ bearerAuth: [] }],
    tags,
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "A UL Platform user access token (JWT) or a UL Platform service credential (`ulk_…`).",
        },
      },
      schemas,
    },
  };
}

let cached: ReturnType<typeof buildOpenApiDocument> | undefined;
/** Built once per process — the contract does not change at runtime. */
export function openApiDocument() {
  cached ??= buildOpenApiDocument();
  return cached;
}
