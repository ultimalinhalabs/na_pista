import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/contract/openapi.js";

/** ADR-054: writes the committed copy of the contract. Tests fail if it drifts from the generated one. */
const target = fileURLToPath(new URL("../docs/api/openapi.json", import.meta.url));
writeFileSync(target, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
console.log(`OpenAPI written to docs/api/openapi.json`);
process.exit(0);
