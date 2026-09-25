import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { MOMENCE_OPENAPI_SPEC_LOCK } from "../connectors/momence/spec-lock.js";
import { MOMENCE_READ_STREAMS } from "../connectors/momence/streams.js";
import type {
  MomenceHttpMethod,
  MomenceEntityObjectSchema,
  MomenceEntitySchema,
  MomenceEntityValidationContract,
  MomenceJsonPrimitive,
  MomenceLeafDirection,
  MomenceLeafLocation,
  MomenceOpenApiCoverage,
  MomenceOpenApiLeafField,
  MomenceOpenApiOperation,
  MomenceOperationContent,
  MomenceOperationResponse,
} from "../connectors/momence/openapi-coverage-types.js";

const { load: loadYaml } = createRequire(import.meta.url)("js-yaml") as {
  load(source: string): unknown;
};

const GENERATOR_VERSION = 2;
const jsonOutputPath = resolve("connectors/momence/openapi-coverage.generated.json");
const tsOutputPath = resolve("connectors/momence/openapi-coverage.generated.ts");
const checkOnly = process.argv.includes("--check");
const inputFlagIndex = process.argv.indexOf("--input");
const inputPath = inputFlagIndex >= 0 ? process.argv[inputFlagIndex + 1] : undefined;

const HTTP_METHODS = ["delete", "get", "head", "options", "patch", "post", "put"] as const;
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);
const STORE_READ_OPERATION_KEYS = new Set(
  MOMENCE_READ_STREAMS.map(({ endpoint }) => `GET ${endpoint}`),
);

type JsonObject = Record<string, unknown>;

type OpenApiSchema = Readonly<{
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: readonly MomenceJsonPrimitive[];
  properties?: Readonly<Record<string, OpenApiSchema>>;
  required?: readonly string[];
  items?: OpenApiSchema;
  allOf?: readonly OpenApiSchema[];
  oneOf?: readonly OpenApiSchema[];
  anyOf?: readonly OpenApiSchema[];
  additionalProperties?: boolean | OpenApiSchema;
  readOnly?: boolean;
  writeOnly?: boolean;
  description?: string;
}>;

type OpenApiParameter = Readonly<{
  $ref?: string;
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}>;

type OpenApiMedia = Readonly<{ schema?: OpenApiSchema }>;
type OpenApiContent = Readonly<Record<string, OpenApiMedia>>;
type OpenApiRequestBody = Readonly<{
  $ref?: string;
  required?: boolean;
  content?: OpenApiContent;
}>;
type OpenApiResponse = Readonly<{
  $ref?: string;
  content?: OpenApiContent;
}>;
type OpenApiOperation = Readonly<{
  operationId?: string;
  summary?: string;
  tags?: readonly string[];
  parameters?: readonly OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Readonly<Record<string, OpenApiResponse>>;
}>;
type OpenApiPathItem = Readonly<{
  parameters?: readonly OpenApiParameter[];
  [method: string]: unknown;
}>;
type OpenApiDocument = Readonly<{
  openapi?: string;
  info?: Readonly<{ title?: string; version?: string }>;
  servers?: readonly Readonly<{ url?: string }>[];
  paths?: Readonly<Record<string, OpenApiPathItem>>;
  components?: Readonly<{
    schemas?: Readonly<Record<string, OpenApiSchema>>;
  }>;
}>;

type MutableOperation = {
  key: string;
  operationId: string;
  method: MomenceHttpMethod;
  path: string;
  summary: string;
  tags: string[];
  requestContents: MomenceOperationContent[];
  responses: MomenceOperationResponse[];
  leafFieldIds: string[];
};

type VisitContext = Readonly<{
  operationKey: string;
  operationId: string;
  method: MomenceHttpMethod;
  path: string;
  direction: MomenceLeafDirection;
  location: MomenceLeafLocation;
  statusCode?: string;
  contentType?: string;
  rootSchema: string;
  fieldPath: string;
  required: boolean;
  requiredInSchema: boolean;
  nullable: boolean;
  conditional: boolean;
  openApiReadOnly: boolean;
  openApiWriteOnly: boolean;
  ownerSchema: string;
  ancestrySourcePointers: readonly string[];
  ancestorRefs: ReadonlySet<string>;
}>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestLines(values: readonly string[]): string {
  return sha256([...values].sort(compareText).join("\n"));
}

function pointerEscape(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function pointerUnescape(value: string): string {
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolvePointer(document: OpenApiDocument, pointer: string): unknown {
  if (!pointer.startsWith("#/")) throw new Error(`Momence OpenAPI contains unsupported external reference ${pointer}.`);
  let current: unknown = document;
  for (const segment of pointer.slice(2).split("/").map(pointerUnescape)) {
    if (!isObject(current) || !(segment in current)) throw new Error(`Unresolved Momence OpenAPI pointer ${pointer}.`);
    current = current[segment];
  }
  return current;
}

function componentSchemaAtPointer(pointer: string): string | undefined {
  const match = pointer.match(/^#\/components\/schemas\/([^/]+)/u);
  return match?.[1] ? pointerUnescape(match[1]) : undefined;
}

function dereference<T extends { readonly $ref?: string }>(document: OpenApiDocument, value: T, label: string): T {
  if (!value.$ref) return value;
  const resolved = resolvePointer(document, value.$ref);
  if (!isObject(resolved)) throw new Error(`${label} reference ${value.$ref} is not an object.`);
  return resolved as T;
}

function schemaRoots(schema: OpenApiSchema): string[] {
  const roots = new Set<string>();
  const visit = (node: OpenApiSchema): void => {
    if (node.$ref) {
      roots.add(componentSchemaAtPointer(node.$ref) ?? node.$ref);
      return;
    }
    const branches = [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])];
    if (branches.length > 0) {
      for (const branch of branches) visit(branch);
    } else {
      roots.add("(inline)");
    }
  };
  visit(schema);
  return [...roots].sort(compareText);
}

function schemaType(schema: OpenApiSchema): string {
  if (schema.$ref) return `ref:${componentSchemaAtPointer(schema.$ref) ?? schema.$ref}`;
  if (schema.oneOf?.length) return `oneOf<${schema.oneOf.map(schemaType).join("|")}>`;
  if (schema.anyOf?.length) return `anyOf<${schema.anyOf.map(schemaType).join("|")}>`;
  if (schema.allOf?.length) return `allOf<${schema.allOf.map(schemaType).join("&")}>`;
  if (schema.type === "array") return `array<${schema.items ? schemaType(schema.items) : "unknown"}>`;
  if (schema.type) return schema.type;
  if (schema.properties || schema.additionalProperties !== undefined) return "object";
  return "unknown";
}

function appendFieldPath(prefix: string, field: string): string {
  return prefix ? `${prefix}.${field}` : field;
}

function fieldIdentity(field: Omit<MomenceOpenApiLeafField, "id">): string {
  return [
    field.operationKey,
    field.direction,
    field.location,
    field.statusCode ?? "",
    field.contentType ?? "",
    field.rootSchema,
    field.schema,
    field.schemaPath,
    field.fieldPath,
    field.jsonType,
    field.sourcePointer,
    field.ancestrySourcePointers.join(">"),
  ].join("\u0000");
}

function leafInventoryLine(field: MomenceOpenApiLeafField): string {
  return [
    field.id,
    field.method,
    field.path,
    field.schema,
    field.fieldPath,
    field.type,
    field.required ? "required" : "optional",
    field.nullable ? "nullable" : "non-null",
    field.readability,
    field.storeReadReachable ? "store-readable" : "not-store-readable",
    field.sourcePointer,
  ].join("\u0000");
}

function fieldSortLine(field: MomenceOpenApiLeafField): string {
  return [
    field.operationKey,
    field.direction,
    field.location,
    field.statusCode ?? "",
    field.contentType ?? "",
    field.fieldPath,
    field.schema,
    field.schemaPath,
    field.id,
  ].join("\u0000");
}

async function readSource(): Promise<Uint8Array> {
  if (inputFlagIndex >= 0 && !inputPath) throw new Error("--input requires a file path.");
  if (inputPath) return readFileSync(resolve(inputPath));
  const response = await fetch(MOMENCE_OPENAPI_SPEC_LOCK.sourceUrl, {
    headers: { accept: "application/yaml, text/yaml, text/plain" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Momence OpenAPI download failed with HTTP ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

function refsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, found);
  } else if (isObject(value)) {
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/components/schemas/")) {
      const name = componentSchemaAtPointer(value.$ref);
      if (name) found.add(name);
    }
    for (const nested of Object.values(value)) refsIn(nested, found);
  }
  return found;
}

function reachableSchemaNames(document: OpenApiDocument, schemas: Readonly<Record<string, OpenApiSchema>>): string[] {
  const found = refsIn(document.paths);
  const queue = [...found];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const schema = schemas[name];
    if (!schema) throw new Error(`Momence operation references missing component schema ${name}.`);
    for (const reference of refsIn(schema)) {
      if (!found.has(reference)) {
        found.add(reference);
        queue.push(reference);
      }
    }
  }
  return [...found].sort(compareText);
}

function componentPropertyPointers(
  schemas: Readonly<Record<string, OpenApiSchema>>,
  reachableSchemas: readonly string[],
): string[] {
  const pointers = new Set<string>();
  const visitInline = (schema: OpenApiSchema, pointer: string): void => {
    for (const [name, property] of Object.entries(schema.properties ?? {}).sort(([a], [b]) => compareText(a, b))) {
      const propertyPointer = `${pointer}/properties/${pointerEscape(name)}`;
      pointers.add(propertyPointer);
      visitInline(property, propertyPointer);
    }
    if (schema.items) visitInline(schema.items, `${pointer}/items`);
    for (const keyword of ["allOf", "oneOf", "anyOf"] as const) {
      for (const [index, branch] of (schema[keyword] ?? []).entries()) {
        visitInline(branch, `${pointer}/${keyword}/${index}`);
      }
    }
    if (isObject(schema.additionalProperties)) visitInline(schema.additionalProperties as OpenApiSchema, `${pointer}/additionalProperties`);
  };
  for (const name of reachableSchemas) {
    visitInline(schemas[name]!, `#/components/schemas/${pointerEscape(name)}`);
  }
  return [...pointers].sort(compareText);
}

type SchemaLocation = Readonly<{
  schema: OpenApiSchema;
  sourcePointer: string;
}>;

function withNullable(schema: MomenceEntitySchema, nullable: boolean): MomenceEntitySchema {
  return nullable && !schema.nullable ? { ...schema, nullable: true } : schema;
}

function schemaPropertyLocation(
  document: OpenApiDocument,
  location: SchemaLocation,
  propertyName: string,
  ancestorRefs = new Set<string>(),
): SchemaLocation | undefined {
  const { schema, sourcePointer } = location;
  if (schema.$ref) {
    if (ancestorRefs.has(schema.$ref)) {
      throw new Error(`Recursive Momence OpenAPI schema reference is unsupported at ${schema.$ref}.`);
    }
    const resolved = resolvePointer(document, schema.$ref);
    if (!isObject(resolved)) throw new Error(`Schema reference ${schema.$ref} is not an object.`);
    const ancestors = new Set(ancestorRefs);
    ancestors.add(schema.$ref);
    return schemaPropertyLocation(document, {
      schema: resolved as OpenApiSchema,
      sourcePointer: schema.$ref,
    }, propertyName, ancestors);
  }
  const property = schema.properties?.[propertyName];
  if (property) {
    return {
      schema: property,
      sourcePointer: `${sourcePointer}/properties/${pointerEscape(propertyName)}`,
    };
  }
  const matches = (schema.allOf ?? []).flatMap((branch, index) => {
    const match = schemaPropertyLocation(document, {
      schema: branch,
      sourcePointer: `${sourcePointer}/allOf/${index}`,
    }, propertyName, ancestorRefs);
    return match ? [match] : [];
  });
  if (matches.length > 1) {
    throw new Error(`Momence schema defines ${propertyName} more than once at ${sourcePointer}.`);
  }
  return matches[0];
}

function arrayItemLocation(document: OpenApiDocument, location: SchemaLocation): SchemaLocation {
  const { schema, sourcePointer } = location;
  if (schema.$ref) {
    const resolved = resolvePointer(document, schema.$ref);
    if (!isObject(resolved)) throw new Error(`Schema reference ${schema.$ref} is not an object.`);
    return arrayItemLocation(document, {
      schema: resolved as OpenApiSchema,
      sourcePointer: schema.$ref,
    });
  }
  if (schema.items) {
    return { schema: schema.items, sourcePointer: `${sourcePointer}/items` };
  }
  throw new Error(`Expected an array schema at ${sourcePointer}.`);
}

function mergeAllOfEntitySchemas(
  schemas: readonly MomenceEntitySchema[],
  sourcePointer: string,
  nullable: boolean,
): MomenceEntitySchema {
  const meaningful = schemas.filter((schema) => schema.kind !== "unknown" || schema.enumValues?.length);
  if (meaningful.length === 0) {
    return { kind: "unknown", sourcePointer, nullable };
  }
  if (meaningful.every((schema): schema is MomenceEntityObjectSchema => schema.kind === "object")) {
    const properties: Record<string, MomenceEntitySchema> = {};
    const required = new Set<string>();
    let additionalProperties: MomenceEntityObjectSchema["additionalProperties"] = false;
    for (const schema of meaningful) {
      for (const [name, property] of Object.entries(schema.properties)) {
        const previous = properties[name];
        if (previous && JSON.stringify(previous) !== JSON.stringify(property)) {
          throw new Error(`Momence allOf has incompatible definitions for ${name} at ${sourcePointer}.`);
        }
        properties[name] = property;
      }
      for (const name of schema.required) required.add(name);
      if (schema.additionalProperties === true) additionalProperties = true;
      else if (typeof schema.additionalProperties === "object") {
        if (
          typeof additionalProperties === "object" &&
          JSON.stringify(additionalProperties) !== JSON.stringify(schema.additionalProperties)
        ) {
          throw new Error(`Momence allOf has incompatible additional properties at ${sourcePointer}.`);
        }
        additionalProperties = schema.additionalProperties;
      }
    }
    return {
      kind: "object",
      sourcePointer,
      nullable: nullable || meaningful.every((schema) => schema.nullable),
      properties: Object.fromEntries(Object.entries(properties).sort(([a], [b]) => compareText(a, b))),
      required: [...required].sort(compareText),
      additionalProperties,
    };
  }
  if (meaningful.length === 1) return withNullable(meaningful[0]!, nullable);
  const [first, ...rest] = meaningful;
  if (rest.every((schema) => JSON.stringify({ ...schema, sourcePointer: "" }) === JSON.stringify({ ...first!, sourcePointer: "" }))) {
    return withNullable(first!, nullable);
  }
  throw new Error(`Momence allOf at ${sourcePointer} cannot be represented as a deterministic entity contract.`);
}

function enumKind(values: readonly MomenceJsonPrimitive[]): "boolean" | "number" | "string" | undefined {
  const kinds = new Set(values.filter((value) => value !== null).map((value) => typeof value));
  if (kinds.size !== 1) return undefined;
  const [kind] = kinds;
  return kind === "string" || kind === "number" || kind === "boolean" ? kind : undefined;
}

function normalizeEntitySchema(
  document: OpenApiDocument,
  schema: OpenApiSchema,
  sourcePointer: string,
  ancestorRefs = new Set<string>(),
): MomenceEntitySchema {
  const nullable = schema.nullable === true;
  if (schema.$ref) {
    if (ancestorRefs.has(schema.$ref)) {
      throw new Error(`Recursive Momence OpenAPI schema reference is unsupported at ${schema.$ref}.`);
    }
    const resolved = resolvePointer(document, schema.$ref);
    if (!isObject(resolved)) throw new Error(`Schema reference ${schema.$ref} is not an object.`);
    const ancestors = new Set(ancestorRefs);
    ancestors.add(schema.$ref);
    return withNullable(
      normalizeEntitySchema(document, resolved as OpenApiSchema, schema.$ref, ancestors),
      nullable,
    );
  }

  if (schema.allOf?.length) {
    const branches = schema.allOf.map((branch, index) => normalizeEntitySchema(
      document,
      branch,
      `${sourcePointer}/allOf/${index}`,
      ancestorRefs,
    ));
    return mergeAllOfEntitySchemas(branches, sourcePointer, nullable);
  }

  const union = schema.oneOf?.length
    ? { mode: "oneOf" as const, branches: schema.oneOf }
    : schema.anyOf?.length
      ? { mode: "anyOf" as const, branches: schema.anyOf }
      : undefined;
  if (union) {
    return {
      kind: "union",
      mode: union.mode,
      sourcePointer,
      nullable,
      variants: union.branches.map((branch, index) => normalizeEntitySchema(
        document,
        branch,
        `${sourcePointer}/${union.mode}/${index}`,
        ancestorRefs,
      )),
    };
  }

  if (schema.type === "array" || schema.items) {
    if (!schema.items) throw new Error(`Momence array schema has no items at ${sourcePointer}.`);
    return {
      kind: "array",
      sourcePointer,
      nullable,
      items: normalizeEntitySchema(document, schema.items, `${sourcePointer}/items`, ancestorRefs),
    };
  }

  if (schema.type === "object" || schema.properties || schema.additionalProperties !== undefined) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(([, property]) => property.writeOnly !== true)
        .sort(([a], [b]) => compareText(a, b))
        .map(([name, property]) => [
          name,
          normalizeEntitySchema(
            document,
            property,
            `${sourcePointer}/properties/${pointerEscape(name)}`,
            ancestorRefs,
          ),
        ]),
    );
    const required = (schema.required ?? [])
      .filter((name) => schema.properties?.[name]?.writeOnly !== true)
      .sort(compareText);
    for (const name of required) {
      if (!(name in properties) && schema.additionalProperties !== true && !isObject(schema.additionalProperties)) {
        throw new Error(`Momence object requires undocumented property ${name} at ${sourcePointer}.`);
      }
    }
    return {
      kind: "object",
      sourcePointer,
      nullable,
      properties,
      required,
      additionalProperties: schema.additionalProperties === true
        ? true
        : isObject(schema.additionalProperties)
          ? normalizeEntitySchema(
              document,
              schema.additionalProperties as OpenApiSchema,
              `${sourcePointer}/additionalProperties`,
              ancestorRefs,
            )
          : false,
    };
  }

  const inferredKind = schema.type === "string" || schema.type === "number" ||
    schema.type === "integer" || schema.type === "boolean"
    ? schema.type
    : schema.enum
      ? enumKind(schema.enum)
      : undefined;
  return {
    kind: inferredKind ?? "unknown",
    sourcePointer,
    nullable,
    ...(schema.format ? { format: schema.format } : {}),
    ...(schema.enum ? { enumValues: [...schema.enum] } : {}),
  };
}

function buildEntityValidationContracts(document: OpenApiDocument): MomenceEntityValidationContract[] {
  const paths = document.paths ?? {};
  return MOMENCE_READ_STREAMS.map((stream): MomenceEntityValidationContract => {
    const operation = paths[stream.endpoint]?.get;
    if (!isObject(operation)) throw new Error(`Momence read stream ${stream.id} has no GET operation.`);
    const unresolvedResponse = (operation as OpenApiOperation).responses?.["200"];
    if (!unresolvedResponse) throw new Error(`Momence read stream ${stream.id} has no HTTP 200 response.`);
    const response = dereference(document, unresolvedResponse, "Response");
    const contentType = "application/json";
    const responseSchema = response.content?.[contentType]?.schema;
    if (!responseSchema) {
      throw new Error(`Momence read stream ${stream.id} has no ${contentType} response schema.`);
    }
    const operationPointer = `#/paths/${pointerEscape(stream.endpoint)}/get`;
    const responseLocation: SchemaLocation = {
      schema: responseSchema,
      sourcePointer: `${operationPointer}/responses/200/content/${pointerEscape(contentType)}/schema`,
    };
    const entityLocation = stream.kind === "singleton" ||
      (stream.kind === "fanout" && stream.childPagination === "singleton")
      ? responseLocation
      : arrayItemLocation(
          document,
          schemaPropertyLocation(document, responseLocation, "payload") ?? (() => {
            throw new Error(`Momence read stream ${stream.id} page schema has no payload property.`);
          })(),
        );
    return {
      streamId: stream.id,
      operationKey: `GET ${stream.endpoint}`,
      responseStatus: "200",
      contentType,
      rootSchema: schemaRoots(entityLocation.schema).join(" | "),
      entitySourcePointer: entityLocation.sourcePointer,
      schema: normalizeEntitySchema(
        document,
        entityLocation.schema,
        entityLocation.sourcePointer,
      ),
    };
  }).sort((a, b) => compareText(a.streamId, b.streamId));
}

function buildCoverage(document: OpenApiDocument, sourceBytes: Uint8Array): MomenceOpenApiCoverage {
  const paths = document.paths ?? {};
  const schemas = document.components?.schemas ?? {};
  const reachableSchemas = reachableSchemaNames(document, schemas);
  const unreachableSchemas = Object.keys(schemas).filter((name) => !reachableSchemas.includes(name)).sort(compareText);
  const propertyPointers = componentPropertyPointers(schemas, reachableSchemas);
  const visitedPropertyPointers = new Set<string>();
  const fieldsById = new Map<string, MomenceOpenApiLeafField>();

  const emit = (fieldWithoutId: Omit<MomenceOpenApiLeafField, "id">): string => {
    const id = sha256(fieldIdentity(fieldWithoutId)).slice(0, 24);
    const field: MomenceOpenApiLeafField = { id, ...fieldWithoutId };
    const previous = fieldsById.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(field)) {
      throw new Error(`Momence leaf field id collision for ${id}.`);
    }
    fieldsById.set(id, field);
    for (const pointer of field.ancestrySourcePointers) {
      if (pointer.startsWith("#/components/schemas/")) visitedPropertyPointers.add(pointer);
    }
    if (field.sourcePointer.startsWith("#/components/schemas/") && field.sourcePointer.includes("/properties/")) {
      visitedPropertyPointers.add(field.sourcePointer);
    }
    return id;
  };

  const visitSchema = (
    schema: OpenApiSchema,
    sourcePointer: string,
    context: VisitContext,
    outputIds: string[],
  ): void => {
    const inheritedNullable = context.nullable || schema.nullable === true;
    const inheritedReadOnly = context.openApiReadOnly || schema.readOnly === true;
    const inheritedWriteOnly = context.openApiWriteOnly || schema.writeOnly === true;

    if (schema.$ref) {
      if (context.ancestorRefs.has(schema.$ref)) {
        throw new Error(`Recursive Momence OpenAPI schema reference is unsupported at ${schema.$ref}.`);
      }
      const resolved = resolvePointer(document, schema.$ref);
      if (!isObject(resolved)) throw new Error(`Schema reference ${schema.$ref} is not an object.`);
      const ancestors = new Set(context.ancestorRefs);
      ancestors.add(schema.$ref);
      visitSchema(resolved as OpenApiSchema, schema.$ref, {
        ...context,
        nullable: inheritedNullable,
        openApiReadOnly: inheritedReadOnly,
        openApiWriteOnly: inheritedWriteOnly,
        ownerSchema: componentSchemaAtPointer(schema.$ref) ?? context.ownerSchema,
        ancestorRefs: ancestors,
      }, outputIds);
      return;
    }

    const compositions = [
      ["allOf", schema.allOf ?? [], false],
      ["oneOf", schema.oneOf ?? [], (schema.oneOf?.length ?? 0) > 1],
      ["anyOf", schema.anyOf ?? [], (schema.anyOf?.length ?? 0) > 1],
    ] as const;
    let followedComposition = false;
    for (const [keyword, branches, conditional] of compositions) {
      for (const [index, branch] of branches.entries()) {
        followedComposition = true;
        visitSchema(branch, `${sourcePointer}/${keyword}/${index}`, {
          ...context,
          nullable: inheritedNullable,
          conditional: context.conditional || conditional,
          openApiReadOnly: inheritedReadOnly,
          openApiWriteOnly: inheritedWriteOnly,
        }, outputIds);
      }
    }

    if (schema.type === "array" || schema.items) {
      if (schema.items) {
        visitSchema(schema.items, `${sourcePointer}/items`, {
          ...context,
          fieldPath: `${context.fieldPath}[]`,
          nullable: inheritedNullable,
          openApiReadOnly: inheritedReadOnly,
          openApiWriteOnly: inheritedWriteOnly,
        }, outputIds);
      } else {
        const readable = context.direction === "response" && !inheritedWriteOnly;
        outputIds.push(emit({
          operationKey: context.operationKey,
          operationId: context.operationId,
          method: context.method,
          path: context.path,
          direction: context.direction,
          location: context.location,
          ...(context.statusCode ? { statusCode: context.statusCode } : {}),
          ...(context.contentType ? { contentType: context.contentType } : {}),
          rootSchema: context.rootSchema,
          schema: context.ownerSchema,
          schemaPath: sourcePointer,
          fieldPath: context.fieldPath,
          type: "array<unknown>",
          jsonType: "array<unknown>",
          required: context.required,
          requiredInSchema: context.requiredInSchema,
          nullable: inheritedNullable,
          readable,
          readability: readable ? "response-readable" : "request-only",
          storeReadReachable: readable && STORE_READ_OPERATION_KEYS.has(context.operationKey),
          openApiReadOnly: inheritedReadOnly,
          openApiWriteOnly: inheritedWriteOnly,
          sourcePointer,
          conditional: context.conditional,
          ancestrySourcePointers: [...context.ancestrySourcePointers],
        }));
      }
      return;
    }

    const properties = Object.entries(schema.properties ?? {}).sort(([a], [b]) => compareText(a, b));
    if (properties.length > 0) {
      const requiredNames = new Set(schema.required ?? []);
      for (const [name, property] of properties) {
        const propertyPointer = `${sourcePointer}/properties/${pointerEscape(name)}`;
        const requiredInSchema = requiredNames.has(name);
        visitSchema(property, propertyPointer, {
          ...context,
          fieldPath: appendFieldPath(context.fieldPath, name),
          required: context.required && !inheritedNullable && requiredInSchema,
          requiredInSchema,
          nullable: property.nullable === true,
          conditional: context.conditional || inheritedNullable || !requiredInSchema,
          openApiReadOnly: inheritedReadOnly,
          openApiWriteOnly: inheritedWriteOnly,
          ancestrySourcePointers: [...context.ancestrySourcePointers, propertyPointer],
        }, outputIds);
      }
      return;
    }

    if (isObject(schema.additionalProperties)) {
      visitSchema(schema.additionalProperties as OpenApiSchema, `${sourcePointer}/additionalProperties`, {
        ...context,
        fieldPath: appendFieldPath(context.fieldPath, "{*}"),
        nullable: inheritedNullable,
        conditional: true,
        openApiReadOnly: inheritedReadOnly,
        openApiWriteOnly: inheritedWriteOnly,
      }, outputIds);
      return;
    }

    if (followedComposition) return;

    const readable = context.direction === "response" && !inheritedWriteOnly;
    outputIds.push(emit({
      operationKey: context.operationKey,
      operationId: context.operationId,
      method: context.method,
      path: context.path,
      direction: context.direction,
      location: context.location,
      ...(context.statusCode ? { statusCode: context.statusCode } : {}),
      ...(context.contentType ? { contentType: context.contentType } : {}),
      rootSchema: context.rootSchema,
      schema: context.ownerSchema,
      schemaPath: sourcePointer,
      fieldPath: context.fieldPath,
      type: schemaType(schema),
      jsonType: schemaType(schema),
      ...(schema.format ? { format: schema.format } : {}),
      ...(schema.enum ? { enumValues: [...schema.enum] } : {}),
      required: context.required,
      requiredInSchema: context.requiredInSchema,
      nullable: inheritedNullable,
      conditional: context.conditional,
      readable,
      readability: readable ? "response-readable" : "request-only",
      storeReadReachable: readable && STORE_READ_OPERATION_KEYS.has(context.operationKey),
      openApiReadOnly: inheritedReadOnly,
      openApiWriteOnly: inheritedWriteOnly,
      ...(schema.description ? { description: schema.description } : {}),
      sourcePointer,
      ancestrySourcePointers: [...context.ancestrySourcePointers],
    }));
  };

  const operations: MutableOperation[] = [];
  for (const [path, pathItem] of Object.entries(paths).sort(([a], [b]) => compareText(a, b))) {
    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem[method];
      if (!isObject(rawOperation)) continue;
      const operation = rawOperation as OpenApiOperation;
      const upperMethod = method.toUpperCase() as MomenceHttpMethod;
      const operationId = operation.operationId ?? `${upperMethod} ${path}`;
      const key = `${upperMethod} ${path}`;
      const mutable: MutableOperation = {
        key,
        operationId,
        method: upperMethod,
        path,
        summary: operation.summary ?? "",
        tags: [...(operation.tags ?? [])].sort(compareText),
        requestContents: [],
        responses: [],
        leafFieldIds: [],
      };
      const operationPointer = `#/paths/${pointerEscape(path)}/${method}`;

      const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
      for (const [index, unresolvedParameter] of parameters.entries()) {
        const parameterPointer = `${operationPointer}/parameters/${index}`;
        const parameter = dereference(document, unresolvedParameter, "Parameter");
        if (!parameter.name || !parameter.in || !parameter.schema) {
          throw new Error(`${key} has an incomplete parameter at index ${index}.`);
        }
        if (!["cookie", "header", "path", "query"].includes(parameter.in)) {
          throw new Error(`${key} has unsupported parameter location ${parameter.in}.`);
        }
        const schemaPointer = unresolvedParameter.$ref ? `${unresolvedParameter.$ref}/schema` : `${parameterPointer}/schema`;
        const readable = false;
        const fieldWithoutId: Omit<MomenceOpenApiLeafField, "id"> = {
          operationKey: key,
          operationId,
          method: upperMethod,
          path,
          direction: "request",
          location: parameter.in as MomenceLeafLocation,
          rootSchema: "(parameter)",
          schema: componentSchemaAtPointer(schemaPointer) ?? "(parameter)",
          schemaPath: schemaPointer,
          fieldPath: `$${parameter.in}.${parameter.name}`,
          type: schemaType(parameter.schema),
          jsonType: schemaType(parameter.schema),
          ...(parameter.schema.format ? { format: parameter.schema.format } : {}),
          ...(parameter.schema.enum ?? parameter.schema.items?.enum
            ? { enumValues: [...(parameter.schema.enum ?? parameter.schema.items?.enum ?? [])] }
            : {}),
          required: parameter.required === true,
          requiredInSchema: parameter.required === true,
          nullable: parameter.schema.nullable === true,
          conditional: parameter.required !== true,
          readable,
          readability: "request-only",
          storeReadReachable: false,
          openApiReadOnly: parameter.schema.readOnly === true,
          openApiWriteOnly: parameter.schema.writeOnly === true,
          ...(parameter.description ?? parameter.schema.description
            ? { description: parameter.description ?? parameter.schema.description }
            : {}),
          sourcePointer: schemaPointer,
          ancestrySourcePointers: [],
        };
        mutable.leafFieldIds.push(emit(fieldWithoutId));
      }

      if (operation.requestBody) {
        const requestBody = dereference(document, operation.requestBody, "Request body");
        for (const [contentType, media] of Object.entries(requestBody.content ?? {}).sort(([a], [b]) => compareText(a, b))) {
          if (!media.schema) continue;
          const ids: string[] = [];
          const roots = schemaRoots(media.schema);
          visitSchema(media.schema, `${operationPointer}/requestBody/content/${pointerEscape(contentType)}/schema`, {
            operationKey: key,
            operationId,
            method: upperMethod,
            path,
            direction: "request",
            location: "requestBody",
            contentType,
            rootSchema: roots.join(" | "),
            fieldPath: "$request",
            required: requestBody.required === true,
            requiredInSchema: requestBody.required === true,
            nullable: false,
            conditional: false,
            openApiReadOnly: false,
            openApiWriteOnly: false,
            ownerSchema: "(inline)",
            ancestrySourcePointers: [],
            ancestorRefs: new Set(),
          }, ids);
          const leafFieldIds = [...new Set(ids)].sort(compareText);
          mutable.leafFieldIds.push(...leafFieldIds);
          mutable.requestContents.push({
            contentType,
            required: requestBody.required === true,
            schemaRoots: roots,
            leafFieldIds,
          });
        }
      }

      for (const [statusCode, unresolvedResponse] of Object.entries(operation.responses ?? {}).sort(([a], [b]) => compareText(a, b))) {
        const response = dereference(document, unresolvedResponse, "Response");
        const contents: MomenceOperationContent[] = [];
        for (const [contentType, media] of Object.entries(response.content ?? {}).sort(([a], [b]) => compareText(a, b))) {
          if (!media.schema) continue;
          const ids: string[] = [];
          const roots = schemaRoots(media.schema);
          visitSchema(media.schema, `${operationPointer}/responses/${pointerEscape(statusCode)}/content/${pointerEscape(contentType)}/schema`, {
            operationKey: key,
            operationId,
            method: upperMethod,
            path,
            direction: "response",
            location: "responseBody",
            statusCode,
            contentType,
            rootSchema: roots.join(" | "),
            fieldPath: "$response",
            required: true,
            requiredInSchema: true,
            nullable: false,
            conditional: false,
            openApiReadOnly: false,
            openApiWriteOnly: false,
            ownerSchema: "(inline)",
            ancestrySourcePointers: [],
            ancestorRefs: new Set(),
          }, ids);
          const leafFieldIds = [...new Set(ids)].sort(compareText);
          mutable.leafFieldIds.push(...leafFieldIds);
          contents.push({ contentType, required: true, schemaRoots: roots, leafFieldIds });
        }
        mutable.responses.push({ statusCode, contents });
      }
      mutable.leafFieldIds = [...new Set(mutable.leafFieldIds)].sort(compareText);
      operations.push(mutable);
    }
  }

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const key of Object.keys(pathItem)) {
      if (/^(delete|get|head|options|patch|post|put|trace)$/u.test(key) && !HTTP_METHOD_SET.has(key)) {
        throw new Error(`Unsupported HTTP method ${key.toUpperCase()} at ${path}.`);
      }
    }
  }

  const fields = [...fieldsById.values()].sort((a, b) => compareText(fieldSortLine(a), fieldSortLine(b)));
  const operationRows: MomenceOpenApiOperation[] = operations
    .sort((a, b) => compareText(a.key, b.key))
    .map((operation) => {
      const operationFields = operation.leafFieldIds.map((id) => fieldsById.get(id)!);
      return {
        ...operation,
        requestContents: [...operation.requestContents].sort((a, b) => compareText(a.contentType, b.contentType)),
        responses: [...operation.responses].sort((a, b) => compareText(a.statusCode, b.statusCode)),
        leafFieldIds: [...operation.leafFieldIds].sort(compareText),
        requestLeafCount: operationFields.filter(({ direction }) => direction === "request").length,
        responseLeafCount: operationFields.filter(({ direction }) => direction === "response").length,
      };
    });

  const uncoveredPropertyPointers = propertyPointers.filter((pointer) => !visitedPropertyPointers.has(pointer));
  if (uncoveredPropertyPointers.length > 0) {
    throw new Error(`Momence operation traversal dropped ${uncoveredPropertyPointers.length} reachable component properties: ${uncoveredPropertyPointers.slice(0, 8).join(", ")}`);
  }
  const operationKeys = operationRows.map(({ key }) => key);
  const requestFields = fields.filter(({ direction }) => direction === "request");
  const responseFields = fields.filter(({ direction }) => direction === "response");
  const reachablePropertyPointers = [...visitedPropertyPointers].filter((pointer) => propertyPointers.includes(pointer)).sort(compareText);
  const entityValidationContracts = buildEntityValidationContracts(document);

  return {
    generatorVersion: GENERATOR_VERSION,
    source: {
      url: MOMENCE_OPENAPI_SPEC_LOCK.sourceUrl,
      sha256: sha256(sourceBytes),
      byteLength: sourceBytes.byteLength,
      openapiVersion: document.openapi ?? "",
      apiTitle: document.info?.title ?? "",
      apiVersion: document.info?.version ?? "",
      serverUrls: (document.servers ?? []).flatMap(({ url }) => url ? [url] : []).sort(compareText),
    },
    counts: {
      paths: Object.keys(paths).length,
      operations: operationRows.length,
      componentSchemas: Object.keys(schemas).length,
      reachableSchemas: reachableSchemas.length,
      componentProperties: propertyPointers.length,
      operationLeafFields: fields.length,
      requestLeafFields: requestFields.length,
      responseLeafFields: responseFields.length,
      readableLeafFields: fields.filter(({ readable }) => readable).length,
      parameterLeafFields: fields.filter(({ location }) => ["cookie", "header", "path", "query"].includes(location)).length,
      requestBodyLeafFields: fields.filter(({ location }) => location === "requestBody").length,
      responseBodyLeafFields: fields.filter(({ location }) => location === "responseBody").length,
      uniqueSourceLeafDefinitions: new Set(fields.map((field) => `${field.sourcePointer}\u0000${field.type}`)).size,
      entityValidationContracts: entityValidationContracts.length,
    },
    digests: {
      operationKeySha256: digestLines(operationKeys),
      leafInventorySha256: digestLines(fields.map(leafInventoryLine)),
      reachablePropertySha256: digestLines(reachablePropertyPointers),
      entityValidationContractSha256: digestLines(
        entityValidationContracts.map((contract) => JSON.stringify(contract)),
      ),
    },
    reachableSchemas,
    unreachableSchemas,
    reachablePropertyPointers,
    uncoveredPropertyPointers,
    entityValidationContracts,
    operations: operationRows,
    fields,
  };
}

function assertLockedCoverage(coverage: MomenceOpenApiCoverage): void {
  const lock = MOMENCE_OPENAPI_SPEC_LOCK;
  const actualSource = coverage.source;
  const expectedSource = {
    url: lock.sourceUrl,
    sha256: lock.sourceSha256,
    byteLength: lock.sourceByteLength,
    openapiVersion: lock.openapiVersion,
    apiTitle: lock.apiTitle,
    apiVersion: lock.apiVersion,
  };
  for (const [name, expected] of Object.entries(expectedSource)) {
    const actual = actualSource[name as keyof typeof actualSource];
    if (actual !== expected) throw new Error(`Momence OpenAPI ${name} changed: expected ${expected}, got ${String(actual)}.`);
  }
  if (!actualSource.serverUrls.includes(lock.productionServerUrl)) {
    throw new Error(`Momence OpenAPI no longer declares production server ${lock.productionServerUrl}.`);
  }

  const requiredCounts = ["paths", "operations", "componentSchemas", "reachableSchemas"] as const;
  for (const name of requiredCounts) {
    if (coverage.counts[name] !== lock.expected[name]) {
      throw new Error(`Momence OpenAPI ${name} changed: expected ${lock.expected[name]}, got ${coverage.counts[name]}.`);
    }
  }
  const optionalPinnedCounts = [
    "componentProperties",
    "operationLeafFields",
    "requestLeafFields",
    "responseLeafFields",
    "readableLeafFields",
    "entityValidationContracts",
  ] as const;
  for (const name of optionalPinnedCounts) {
    const expected = lock.expected[name];
    if (expected > 0 && coverage.counts[name] !== expected) {
      throw new Error(`Momence OpenAPI ${name} changed: expected ${expected}, got ${coverage.counts[name]}.`);
    }
  }
  const optionalPinnedDigests = [
    "operationKeySha256",
    "leafInventorySha256",
    "reachablePropertySha256",
    "entityValidationContractSha256",
  ] as const;
  for (const name of optionalPinnedDigests) {
    const expected = lock.expected[name];
    if (expected && coverage.digests[name] !== expected) {
      throw new Error(`Momence OpenAPI ${name} changed: expected ${expected}, got ${coverage.digests[name]}.`);
    }
  }
}

function renderTypeScript(): string {
  return `/**\n * GENERATED by scripts/generate-momence-openapi-coverage.mts. DO NOT EDIT.\n * Exact source lock: ${MOMENCE_OPENAPI_SPEC_LOCK.sourceSha256}\n */\nimport coverageJson from "./openapi-coverage.generated.json" with { type: "json" };\nimport type { MomenceEntityValidationContract, MomenceOpenApiCoverage, MomenceOpenApiLeafField } from "./openapi-coverage-types.js";\n\nexport const MOMENCE_OPENAPI_COVERAGE = coverageJson as unknown as MomenceOpenApiCoverage;\n\n/** Flat operation-context field inventory consumed by ingestion and semantic coverage checks. */\nexport const MOMENCE_API_FIELDS: readonly MomenceOpenApiLeafField[] = MOMENCE_OPENAPI_COVERAGE.fields;\n\n/** Strict entity-response schemas consumed by the Momence ingestion validator. */\nexport const MOMENCE_ENTITY_VALIDATION_CONTRACTS: readonly MomenceEntityValidationContract[] =\n  MOMENCE_OPENAPI_COVERAGE.entityValidationContracts;\n`;
}

const sourceBytes = await readSource();
const parsed = loadYaml(new TextDecoder().decode(sourceBytes));
if (!isObject(parsed)) throw new Error("Momence OpenAPI source did not parse as an object.");
const coverage = buildCoverage(parsed as OpenApiDocument, sourceBytes);
assertLockedCoverage(coverage);
const json = `${JSON.stringify(coverage, null, 2)}\n`;
const typescript = renderTypeScript();

if (checkOnly) {
  if (readFileSync(jsonOutputPath, "utf8") !== json) {
    throw new Error(`${jsonOutputPath} is stale. Run: node --import tsx scripts/generate-momence-openapi-coverage.mts`);
  }
  if (readFileSync(tsOutputPath, "utf8") !== typescript) {
    throw new Error(`${tsOutputPath} is stale. Run: node --import tsx scripts/generate-momence-openapi-coverage.mts`);
  }
} else {
  writeFileSync(jsonOutputPath, json);
  writeFileSync(tsOutputPath, typescript);
}

console.log(JSON.stringify({
  sourceSha256: coverage.source.sha256,
  counts: coverage.counts,
  digests: coverage.digests,
}, null, 2));
