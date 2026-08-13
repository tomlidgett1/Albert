/**
 * Generate the checked-in X-Series endpoint/field census and semantic table
 * dictionary from the deterministic official OpenAPI merge.
 *
 * Usage:
 *   npx tsx connectors/lightspeed-x/generate-contract-artifacts.mts \
 *     --source-dir /tmp/lightspeed-x-series-api-2026-07 \
 *     --bulk-openapi /tmp/lightspeed-x-series-api-2026-07/api-2026-07.json
 *
 * If the reference-fragment directory is unavailable, the checked-in fragment
 * census remains the provenance source while the locked official bulk contract
 * is still fetched and used to regenerate inline response-field coverage.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LIGHTSPEED_X_STREAMS } from "./streams.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Field = Readonly<{
  root_schema: string;
  defining_schema: string;
  field_path: string;
  type?: string;
  format?: string;
  description?: string;
  deprecated: boolean;
  nullable: boolean;
  read_only: boolean;
  write_only: boolean;
  required: boolean;
  official_source_urls: readonly string[];
}>;
type Operation = Readonly<{
  method: string; path: string; operation_id: string; required_scopes: readonly string[];
  official_source_url: string; pagination_strategy: string | null;
  responses: readonly Readonly<{ status: string; schema_label: string | null }>[];
}>;

const here = dirname(fileURLToPath(import.meta.url));
const sourceFlag = process.argv.indexOf("--source-dir");
const sourceDir = resolve(sourceFlag >= 0 ? process.argv[sourceFlag + 1]! : "/tmp/lightspeed-x-series-api-2026-07");
const bulkFlag = process.argv.indexOf("--bulk-openapi");
const bulkPath = bulkFlag >= 0 ? resolve(process.argv[bulkFlag + 1]!) : null;
const check = process.argv.includes("--check");
const readJsonl = <T,>(name: string): T[] => readFileSync(resolve(sourceDir, name), "utf8")
  .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const stable = (value: Json): string => `${JSON.stringify(value, null, 2)}\n`;
const put = (name: string, value: Json): void => {
  const output = stable(value);
  const path = resolve(here, name);
  if (check) {
    if (readFileSync(path, "utf8") !== output) throw new Error(`${name} is stale.`);
  } else writeFileSync(path, output);
};

const sourceArtifactsAvailable = existsSync(resolve(sourceDir, "schema-fields.expanded.jsonl")) &&
  existsSync(resolve(sourceDir, "operations.jsonl"));
const checkedInFieldCensus = JSON.parse(
  readFileSync(resolve(here, "field-census.generated.json"), "utf8"),
) as { apiVersion: string; sourceArtifact: string; sourceSha256: string; fieldCount: number; fields: Field[] };
const checkedInEndpointCensus = JSON.parse(
  readFileSync(resolve(here, "endpoint-census.generated.json"), "utf8"),
) as Json[];
const fields = sourceArtifactsAvailable
  ? readJsonl<Field>("schema-fields.expanded.jsonl")
  : checkedInFieldCensus.fields;
const operations = sourceArtifactsAvailable ? readJsonl<Operation>("operations.jsonl") : [];

const officialBulkUrl = "https://x-series-api.lightspeedhq.com/openapi/api-2026-07.yaml";
const officialBulkSha256 = "123b2630178c376990dd7219f92e068e5f77ac9cd991a80e0fafa97ad8613dd7";
const bulkText = bulkPath
  ? readFileSync(bulkPath, "utf8")
  : await (async (): Promise<string> => {
    const response = await fetch(officialBulkUrl, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Unable to download official X-Series OpenAPI: ${response.status}.`);
    return response.text();
  })();
if (sha256(bulkText) !== officialBulkSha256) {
  throw new Error("The official X-Series bulk OpenAPI changed; review and update the contract lock before regeneration.");
}
const bulkOpenApi = JSON.parse(bulkText) as JsonObject;
const object = (value: Json | undefined): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const array = (value: Json | undefined): Json[] => Array.isArray(value) ? value : [];
const string = (value: Json | undefined): string | null => typeof value === "string" ? value : null;
const schemas = object(object(bulkOpenApi.components)?.schemas) ?? {};
const refPrefix = "#/components/schemas/";
const refName = (schema: Json | undefined): string | null => {
  const ref = string(object(schema)?.$ref);
  return ref?.startsWith(refPrefix) ? decodeURIComponent(ref.slice(refPrefix.length)) : null;
};
const dereference = (schema: Json | undefined): JsonObject | null => {
  const name = refName(schema);
  return name ? object(schemas[name]) : object(schema);
};
const schemaAlternatives = (schema: Json | undefined): JsonObject[] => {
  const resolved = dereference(schema);
  if (!resolved) return [];
  const composites = ["allOf", "oneOf", "anyOf"].flatMap((key) => array(resolved[key]))
    .flatMap((candidate) => schemaAlternatives(candidate));
  return [resolved, ...composites];
};
const property = (schema: Json | undefined, name: string): Json | undefined => {
  for (const candidate of schemaAlternatives(schema)) {
    const found = object(candidate.properties)?.[name];
    if (found !== undefined) return found;
  }
  return undefined;
};
const arrayItems = (schema: Json | undefined): Json | undefined => {
  for (const candidate of schemaAlternatives(schema)) {
    if (candidate.items !== undefined) return candidate.items;
  }
  return undefined;
};
const entitySchemaAt = (schema: Json, responsePath: string): Json | null => {
  let current: Json | undefined = schema;
  if (responsePath !== "$") {
    for (const segment of responsePath.split(".")) {
      current = property(current, segment);
      if (current === undefined) return null;
    }
  }
  return arrayItems(current) ?? current ?? null;
};
type BulkResponseField = Readonly<{
  field_path: string;
  type?: string;
  format?: string;
  description?: string;
  deprecated: boolean;
  nullable: boolean;
  read_only: boolean;
  write_only: boolean;
  required: boolean;
}>;
const resolvedType = (schema: Json): string | undefined => {
  for (const candidate of schemaAlternatives(schema)) {
    const type = string(candidate.type);
    if (type) return type;
    if (candidate.properties !== undefined) return "object";
    if (candidate.items !== undefined) return "array";
  }
  return undefined;
};
const enumerateResponseFields = (
  schema: Json,
  prefix = "",
  rows = new Map<string, BulkResponseField>(),
  refStack = new Set<string>(),
): Map<string, BulkResponseField> => {
  const referencedSchema = refName(schema);
  if (referencedSchema) {
    if (refStack.has(referencedSchema)) return rows;
    const nextStack = new Set(refStack); nextStack.add(referencedSchema);
    const target = schemas[referencedSchema];
    if (target !== undefined) enumerateResponseFields(target, prefix, rows, nextStack);
    return rows;
  }
  const resolved = object(schema);
  if (!resolved) return rows;
  for (const key of ["allOf", "oneOf", "anyOf"]) {
    for (const candidate of array(resolved[key])) enumerateResponseFields(candidate, prefix, rows, refStack);
  }
  if (resolved.items !== undefined) enumerateResponseFields(resolved.items, prefix, rows, refStack);
  const required = new Set(array(resolved.required).flatMap((value) => typeof value === "string" ? [value] : []));
  for (const [name, value] of Object.entries(object(resolved.properties) ?? {})) {
    const definition = object(value) ?? {};
    if (definition.writeOnly === true) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    if (!rows.has(path)) {
      const type = resolvedType(value);
      const format = string(definition.format);
      const description = string(definition.description);
      rows.set(path, {
        field_path: path,
        ...(type ? { type } : {}),
        ...(format ? { format } : {}),
        ...(description ? { description } : {}),
        deprecated: definition.deprecated === true,
        nullable: definition.nullable === true,
        read_only: definition.readOnly === true,
        write_only: false,
        required: required.has(name),
      });
    }
    const childPrefix = arrayItems(value) !== undefined ? `${path}[]` : path;
    enumerateResponseFields(value, childPrefix, rows, refStack);
  }
  return rows;
};
const paths = object(bulkOpenApi.paths) ?? {};
const bulkOperation = (method: string, path: string): JsonObject | null =>
  object(object(paths[path])?.[method.toLowerCase()]);
const successfulResponseSchema = (operation: JsonObject | null): Json | null => {
  const responses = object(operation?.responses) ?? {};
  for (const status of Object.keys(responses).filter((value) => value.startsWith("2")).sort()) {
    const content = object(object(responses[status])?.content) ?? {};
    const media = object(content["application/json"]) ?? Object.values(content).map(object).find(Boolean) ?? null;
    if (media?.schema !== undefined) return media.schema;
  }
  return null;
};
const bulkFieldsForStream = (stream: (typeof LIGHTSPEED_X_STREAMS)[number]): Map<string, BulkResponseField> => {
  const responseSchema = successfulResponseSchema(bulkOperation(stream.method, stream.endpoint));
  const rows = new Map<string, BulkResponseField>();
  if (!responseSchema) return rows;
  for (const responsePath of stream.responsePaths) {
    const entity = entitySchemaAt(responseSchema, responsePath);
    if (!entity) throw new Error(`${stream.operationId} response path ${responsePath} is absent from official OpenAPI.`);
    enumerateResponseFields(entity, "", rows);
  }
  return rows;
};

const bulkPathCount = Object.keys(paths).length;
const bulkOperationCount = Object.values(paths).reduce<number>((count, pathItem) => count +
  Object.keys(object(pathItem) ?? {}).filter((method) =>
    ["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(method)).length, 0);
if (bulkPathCount !== 130 || bulkOperationCount !== 196 || Object.keys(schemas).length !== 356) {
  throw new Error("The official X-Series bulk OpenAPI census changed; review the contract before regeneration.");
}
const safeReadPosts = new Set([
  "ApplyDiscount", "ListInventoryRecords", "ListInventoryLevels", "getPartialPackingSlip",
  "GetActivePromoCodesBulk", "BulkBalancesStoreCreditList", "BulkStoreCreditList", "GetUsersById",
]);
const streamByOperation = new Map(LIGHTSPEED_X_STREAMS.map((stream) => [stream.operationId, stream.id]));
const endpointCensus = sourceArtifactsAvailable ? operations.map((operation) => {
  const writeScope = operation.required_scopes.some((scope) => scope.endsWith(":write"));
  const managementScope = operation.required_scopes.includes("webhooks") || operation.path.startsWith("/webhooks");
  const safeMethod = operation.method === "GET" ||
    (operation.method === "POST" && safeReadPosts.has(operation.operation_id));
  const stream = streamByOperation.get(operation.operation_id) ?? null;
  const disposition = !safeMethod
    ? "vendor_write_not_implemented"
    : writeScope
      ? "read_requires_write_capable_scope_not_requested"
      : managementScope
        ? "management_scope_not_requested"
        : stream
          ? "scheduled_read_stream"
          : operation.method === "POST"
            ? "read_function_on_demand_not_scheduled"
            : "read_endpoint_on_demand_or_redundant";
  return {
    operationId: operation.operation_id,
    method: operation.method,
    path: operation.path,
    requiredScopes: operation.required_scopes,
    pagination: operation.pagination_strategy,
    responseSchemas: operation.responses.filter((response) => response.status.startsWith("2"))
      .map((response) => response.schema_label).filter(Boolean),
    officialSourceUrl: operation.official_source_url,
    disposition,
    scheduledStreamId: stream,
  };
}) : checkedInEndpointCensus;

const pii = (path: string): boolean =>
  /(^|[._])(email|phone|mobile|fax|address|postcode|birth|gender|name|username|note|token|card_number)([._\[]|$)/iu.test(path);
type TypedFieldPath = Pick<Field, "field_path" | "type" | "format">;
const stagingType = (field: TypedFieldPath): "text" | "numeric" | "boolean" | "date" | "timestamptz" | "jsonb" => {
  if (field.type === "boolean") return "boolean";
  if (["number", "integer"].includes(field.type ?? "")) return "numeric";
  if (field.format === "date") return "date";
  if (field.format === "date-time" || /(^|[._])(created_at|updated_at|deleted_at|occurred_at|time_in|time_out)$/u.test(field.field_path)) return "timestamptz";
  if (["array", "object"].includes(field.type ?? "")) return "jsonb";
  return "text";
};
const postgresType = (field: TypedFieldPath): string => {
  const type = stagingType(field);
  return type === "numeric" ? "numeric(38,10)" : type;
};
const projectedPath = (fieldPath: string, responsePaths: readonly string[]): string | null => {
  for (const responsePath of responsePaths) {
    if (responsePath === "$") return fieldPath;
    const prefix = `${responsePath.replaceAll(".", ".")}[]`;
    if (fieldPath === prefix) return "$";
    if (fieldPath.startsWith(`${prefix}.`)) return fieldPath.slice(prefix.length + 1);
    // Inline schemas occasionally omit the [] marker on wrapper fields.
    if (fieldPath.startsWith(`${responsePath}.`)) return fieldPath.slice(responsePath.length + 1);
  }
  return null;
};
const curated: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  lx_retailer: new Set(["id", "name", "country", "currency.code", "timezone", "account_status", "domain_prefix"]),
  lx_outlets: new Set(["id", "name", "time_zone", "currency", "deleted_at"]),
  lx_registers: new Set(["id", "name", "outlet_id", "is_open", "deleted_at"]),
  lx_users: new Set(["id", "display_name", "username", "email", "enabled", "deleted_at"]),
  lx_product_categories: new Set(["id", "name", "parent_category_id", "root_category_id"]),
  lx_products: new Set(["id", "family_id", "variant_parent_id", "name", "variant_name", "sku", "active", "deleted_at", "product_category.id"]),
  lx_customers: new Set(["id", "name", "first_name", "last_name", "company_name", "email", "customer_code", "deleted_at"]),
  lx_suppliers: new Set(["id", "name", "description", "deleted_at"]),
  lx_taxes: new Set(["id", "name", "rate", "deleted_at"]),
  lx_sales: new Set(["id", "outlet_id", "register_id", "user_id", "customer_id", "sale_date", "created_at", "updated_at", "state", "totals.total", "totals.total_tax", "totals.total_discount", "line_items", "payments"]),
  lx_inventory: new Set(["id", "product_id", "outlet_id", "current_inventory_level", "average_cost", "deleted_at"]),
  lx_inventory_levels: new Set(["product_id", "location_id", "current_inventory_level", "average_cost", "total_cost"]),
  lx_shifts: new Set(["id", "user_id", "time_in", "time_out", "created_at", "updated_at"]),
});

const fieldsByRoot = new Map<string, Field[]>();
for (const field of fields) {
  const list = fieldsByRoot.get(field.root_schema) ?? [];
  list.push(field); fieldsByRoot.set(field.root_schema, list);
}
const coveredCensus = new Set<string>();
const bulkResponseFieldsByStream = new Map(
  LIGHTSPEED_X_STREAMS.map((stream) => [stream.id, bulkFieldsForStream(stream)] as const),
);
const scheduledResponseFieldCount = [...bulkResponseFieldsByStream.values()]
  .reduce((count, responseFields) => count + responseFields.size, 0);
if (scheduledResponseFieldCount !== 1_323) {
  throw new Error(`Official scheduled response field census changed (${scheduledResponseFieldCount}); review before regeneration.`);
}
type TableColumn = Readonly<{
  name: string;
  type: string;
  api: string;
  description: string;
  key: boolean;
  pii: boolean;
  loadBearing: boolean;
  deprecated: boolean;
}>;
type CoverageRow = Readonly<{
  stream: string;
  field: string;
  disposition: string;
  stagingType: string;
  storageField?: string;
  storageType?: string;
  queryPath?: string;
  target?: string;
  queryable?: boolean;
  reason?: string;
  officialFieldKeys?: readonly string[];
  pii: string;
}>;

const tableRows = LIGHTSPEED_X_STREAMS.map((stream) => {
  const columns = new Map<string, TableColumn>();
  const officialFieldKeysByPath = new Map<string, Set<string>>();
  const bulkFields = bulkResponseFieldsByStream.get(stream.id) ?? new Map<string, BulkResponseField>();
  for (const root of stream.rootSchemas) {
    for (const field of fieldsByRoot.get(root) ?? []) {
      const path = projectedPath(field.field_path, stream.responsePaths) ??
        (stream.responsePaths.includes("$") || stream.rootSchemas.length === 1 && field.root_schema === root
          ? field.field_path : null);
      const bulkPath = path && bulkFields.has(path)
        ? path
        : [...bulkFields.keys()].find((candidate) => candidate.endsWith(`.${field.field_path}`)) ?? null;
      if (bulkPath) {
        const key = `${field.root_schema}:${field.field_path}`;
        coveredCensus.add(key);
        const officialKeys = officialFieldKeysByPath.get(bulkPath) ?? new Set<string>();
        officialKeys.add(key); officialFieldKeysByPath.set(bulkPath, officialKeys);
      }
      if (!path || path === "$" || columns.has(path) || bulkFields.size > 0 && !bulkFields.has(path)) continue;
      columns.set(path, {
        name: path,
        type: postgresType(field),
        api: `${field.root_schema}.${field.field_path}`,
        description: field.description ?? `Official X-Series field ${field.field_path}.`,
        key: stream.recordIdPaths.includes(path),
        pii: pii(path),
        loadBearing: curated[stream.id]?.has(path) ?? false,
        deprecated: field.deprecated,
      });
    }
  }
  for (const field of bulkFields.values()) {
    if (columns.has(field.field_path)) continue;
    columns.set(field.field_path, {
      name: field.field_path,
      type: postgresType(field),
      api: `bulk-response:${stream.operationId}.${field.field_path}`,
      description: field.description ?? `Official X-Series response field ${field.field_path}.`,
      key: stream.recordIdPaths.includes(field.field_path),
      pii: pii(field.field_path),
      loadBearing: curated[stream.id]?.has(field.field_path) ?? false,
      deprecated: field.deprecated,
    });
  }
  if (stream.parent) {
    columns.set(`_albert.parent.${stream.parent.contextField}`, {
      name: `_albert.parent.${stream.parent.contextField}`, type: "text",
      api: `synthetic:_albert.parent.${stream.parent.contextField}`,
      description: "Connector-owned parent fan-out context; raw vendor payload is unchanged.",
      key: true, pii: false, loadBearing: true, deprecated: false,
    });
  }
  columns.set("source_record_id", {
    name: "source_record_id",
    type: "text",
    api: "synthetic:platform_source_record_id",
    description:
      "Stable connector-computed record identity, including parent context where the vendor response has no standalone ID.",
    key: true,
    pii: false,
    loadBearing: true,
    deprecated: false,
  });
  columns.set("payload_json", { name: "payload_json", type: "jsonb", api: "synthetic:immutable_emitted_entity", description: "Unmodified emitted vendor entity; the immutable raw batch remains authoritative.", key: false, pii: true, loadBearing: true, deprecated: false });
  columns.set("field_index", { name: "field_index", type: "jsonb", api: "synthetic:runtime_typed_field_index", description: "Typed index of every native, nested, array, map and future additive leaf.", key: false, pii: true, loadBearing: true, deprecated: false });
  const domain = stream.productDomains[0] ?? "sales";
  return {
    id: stream.id,
    domain,
    grain: `one row per ${stream.resource} emitted by ${stream.operationId}`,
    description: `${stream.label}. Official source: ${stream.documentation}`,
    additivity: stream.reprocessIdenticalPayloadOnNewBatch ? "last_value_over_time" : "non_additive",
    additivityAxis: stream.reprocessIdenticalPayloadOnNewBatch ? "ingested_at" : null,
    primaryKey: ["source_record_id"],
    columns: [...columns.values()].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    officialFieldKeysByPath,
  };
});

const coverage: CoverageRow[] = tableRows.flatMap((table) => table.columns
  // source_record_id is part of Albert's platform envelope, not an API
  // projection owned by the connector manifest.
  .filter((column) => column.name !== "source_record_id")
  .map((column) => ({
  stream: table.id,
  field: column.name,
  disposition: (column.loadBearing && column.name !== "field_index" && column.name !== "payload_json") ? "canonical" : "governed_extension",
  stagingType: column.type.startsWith("numeric") ? "numeric" : column.type,
  ...(!String(column.api).startsWith("synthetic:")
    ? { storageField: "field_index", storageType: "jsonb", queryPath: `$.${column.name}` } : {}),
  ...(column.loadBearing && column.name !== "field_index" && column.name !== "payload_json" ? { target: "connector_mapper" } : {}),
  ...(!String(column.api).startsWith("synthetic:") ? { reason: `Official census ${column.api}` } : {}),
  ...((table.officialFieldKeysByPath.get(column.name)?.size ?? 0) > 0
    ? { officialFieldKeys: [...table.officialFieldKeysByPath.get(column.name)!].sort() } : {}),
  pii: column.pii ? "free_text_untrusted" : "none",
})));
for (const field of fields) {
  const key = `${field.root_schema}:${field.field_path}`;
  if (coveredCensus.has(key)) continue;
  coverage.push({
    stream: "lx_official_contract_unavailable",
    field: key,
    disposition: "unsupported",
    stagingType: stagingType(field),
    queryable: false,
    reason: "The official schema node is not reachable from an enumerable read stream under Albert's read-only grant; write/request-only and opaque query-function contracts are retained explicitly rather than invented.",
    pii: pii(field.field_path) ? "free_text_untrusted" : "none",
  });
}

put("endpoint-census.generated.json", endpointCensus as unknown as Json);
put("field-census.generated.json", (sourceArtifactsAvailable ? {
  apiVersion: "2026-07",
  sourceArtifact: "schema-fields.expanded.jsonl",
  sourceSha256: sha256(readFileSync(resolve(sourceDir, "schema-fields.expanded.jsonl"), "utf8")),
  fieldCount: fields.length,
  fields,
} : checkedInFieldCensus) as unknown as Json);
put("field-coverage.generated.json", coverage as unknown as Json);
put("tables.json", {
  generatedFrom: "Lightspeed Retail X-Series official 2026-07 OpenAPI reference fragments (deterministic merge SHA256 51170855ec69622e0fb1556cfd1af1144e8ab720455c75b88b01d8d465899865)",
  tableCount: tableRows.length,
  tables: tableRows.map((table) => ({
    id: table.id,
    domain: table.domain,
    grain: table.grain,
    description: table.description,
    additivity: table.additivity,
    additivityAxis: table.additivityAxis,
    primaryKey: table.primaryKey,
    columns: table.columns,
  })),
} as unknown as Json);

process.stdout.write(`${check ? "Verified" : "Generated"} ${endpointCensus.length} operations, ${fields.length} official fields, ${coverage.length} coverage rows and ${tableRows.length} tables.\n`);
