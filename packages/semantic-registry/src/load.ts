import { readFileSync } from "node:fs";
import type { RegistryDocument, SemanticRegistry } from "./schema.js";
import {
  buildRegistry,
  generateRegistryDocumentation,
  parseRegistryDocument,
  registryDigest,
  validateRegistry,
} from "./registry-build.js";

export {
  buildRegistry,
  generateCanonicalSchemaDoc,
  generateRegistryDocumentation,
  parseRegistryDocument,
  registryDigest,
  validateRegistry,
} from "./registry-build.js";

export function loadRegistryFile(path: string): SemanticRegistry {
  return buildRegistry(parseRegistryDocument(readFileSync(path, "utf8")));
}

export type { RegistryDocument, SemanticRegistry };
