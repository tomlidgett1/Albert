import { createHash } from "node:crypto";

import {
  SHOPIFY_ADMIN_API_VERSION,
  SHOPIFY_ADMIN_MAX_NODE_EXPOSURE,
  SHOPIFY_ADMIN_MAX_SELECTED_FIELDS,
  SHOPIFY_ADMIN_MAX_SELECTION_DEPTH,
  shopifyAdminCatalogueInputSchema,
  shopifyAdminQueryInputSchema,
  type ShopifyAdminArgumentValue,
  type ShopifyAdminCatalogueInput,
  type ShopifyAdminQueryInput,
  type ShopifyAdminSelection,
} from "../../packages/shopify-admin/src/contract.js";
import {
  indexShopifyAdminSchemaRegistry,
  shopifyGraphQLField,
  shopifyGraphQLNamedType,
  type ShopifyAdminGraphQLSchemaIndex,
  type ShopifyGraphQLField,
  type ShopifyGraphQLInputValue,
  type ShopifyGraphQLType,
} from "./schema-registry.js";
import { SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY } from "./field-value-availability.js";

type TypeRef =
  | Readonly<{ kind: "named"; name: string; nonNull: boolean }>
  | Readonly<{ kind: "list"; item: TypeRef; nonNull: boolean }>;

export type ShopifyAdminCompiledQuery = Readonly<{
  apiVersion: typeof SHOPIFY_ADMIN_API_VERSION;
  registrySha256: string;
  query: string;
  variables: Readonly<Record<string, unknown>>;
  queryDigest: string;
  normalizedInput: ShopifyAdminQueryInput;
  rootField: string;
  selectedPaths: readonly string[];
  requiredScopes: readonly string[];
  /** AND across groups, OR within each group. */
  requiredScopeGroups: readonly (readonly string[])[];
  requiresLevel2: boolean;
  accessLimitations: readonly string[];
  definitions: readonly Readonly<{
    path: string;
    parentType: string;
    field: string;
    type: string;
    description: string | null;
    deprecated: boolean;
    protected: boolean;
    requiredAccess: string | null;
  }>[];
}>;

export class ShopifyAdminPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ShopifyAdminPolicyError";
  }
}

function fail(code: string, message: string): never {
  throw new ShopifyAdminPolicyError(code, message);
}

function parseTypeRef(source: string): TypeRef {
  let offset = 0;
  const parse = (): TypeRef => {
    if (source[offset] === "[") {
      offset += 1;
      const item = parse();
      if (source[offset] !== "]") fail("registry_type_invalid", `Invalid registry type ${source}.`);
      offset += 1;
      const nonNull = source[offset] === "!";
      if (nonNull) offset += 1;
      return { kind: "list", item, nonNull };
    }
    const found = /^[_A-Za-z][_0-9A-Za-z]*/u.exec(source.slice(offset));
    if (!found) fail("registry_type_invalid", `Invalid registry type ${source}.`);
    offset += found[0].length;
    const nonNull = source[offset] === "!";
    if (nonNull) offset += 1;
    return { kind: "named", name: found[0], nonNull };
  };
  const result = parse();
  if (offset !== source.length) fail("registry_type_invalid", `Invalid registry type ${source}.`);
  return result;
}

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}

function assertBoundedJson(value: unknown, depth = 0): void {
  if (depth > 5) fail("argument_json_too_deep", "JSON arguments are limited to five nested levels.");
  if (Array.isArray(value)) {
    if (value.length > 50) fail("argument_json_too_large", "JSON arrays are limited to 50 entries.");
    value.forEach((entry) => assertBoundedJson(entry, depth + 1));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>);
    if (entries.length > 50) fail("argument_json_too_large", "JSON objects are limited to 50 fields.");
    entries.forEach(([, entry]) => assertBoundedJson(entry, depth + 1));
  }
}

function decodeScalar(
  input: ShopifyAdminArgumentValue,
  name: string,
  metadata: ShopifyGraphQLInputValue,
): unknown {
  if (name === "Boolean") {
    if (input.kind !== "boolean") fail("argument_type_invalid", `${metadata.name} requires a Boolean value.`);
    return input.value;
  }
  if (name === "Int") {
    if (input.kind !== "int" || input.value < -2_147_483_648 || input.value > 2_147_483_647) {
      fail("argument_type_invalid", `${metadata.name} requires a signed 32-bit integer.`);
    }
    return input.value;
  }
  if (name === "Float") {
    if (input.kind !== "float" && input.kind !== "int") fail("argument_type_invalid", `${metadata.name} requires a finite number.`);
    return input.value;
  }
  if (name === "ID") {
    if (input.kind !== "id") fail("argument_type_invalid", `${metadata.name} requires an ID value.`);
    if (metadata.gidTypes?.length) {
      const match = /^gid:\/\/shopify\/([^/]+)\/.+$/u.exec(input.value);
      if (!match || (!metadata.gidTypes.includes("Node") && !metadata.gidTypes.includes(match[1]!))) {
        fail("argument_gid_type_invalid", `${metadata.name} requires a Shopify ${metadata.gidTypes.join(" or ")} global ID.`);
      }
    }
    return input.value;
  }
  if (["Decimal", "Money"].includes(name)) {
    if (input.kind !== "decimal") fail("argument_type_invalid", `${metadata.name} requires an exact decimal string.`);
    return input.value;
  }
  if (["BigInt", "UnsignedInt64"].includes(name)) {
    if (input.kind !== "integer_string" || (name === "UnsignedInt64" && input.value.startsWith("-"))) {
      fail("argument_type_invalid", `${metadata.name} requires an exact ${name} decimal integer string.`);
    }
    return input.value;
  }
  if (name === "Date") {
    if (input.kind !== "date" || !calendarDate(input.value)) fail("argument_type_invalid", `${metadata.name} requires a real ISO calendar date.`);
    return input.value;
  }
  if (name === "DateTime") {
    if (input.kind !== "datetime" || !/^\d{4}-\d{2}-\d{2}T/iu.test(input.value) || Number.isNaN(Date.parse(input.value))) {
      fail("argument_type_invalid", `${metadata.name} requires an absolute ISO date-time.`);
    }
    return input.value;
  }
  if (name === "JSON") {
    if (input.kind !== "json") fail("argument_type_invalid", `${metadata.name} requires bounded JSON text.`);
    let parsed: unknown;
    try { parsed = JSON.parse(input.value); } catch { fail("argument_json_invalid", `${metadata.name} is not valid JSON.`); }
    assertBoundedJson(parsed);
    return parsed;
  }
  if (name === "URL") {
    if (input.kind !== "string") fail("argument_type_invalid", `${metadata.name} requires a URL string.`);
    let parsed: URL;
    try { parsed = new URL(input.value); } catch { fail("argument_type_invalid", `${metadata.name} is not a valid URL.`); }
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      fail("argument_type_invalid", `${metadata.name} requires an HTTP(S) URL without embedded credentials.`);
    }
    return parsed.toString();
  }
  if (name === "Color") {
    if (input.kind !== "string" || !/^#[a-f0-9]{6}$/iu.test(input.value)) fail("argument_type_invalid", `${metadata.name} requires a six-digit hexadecimal colour.`);
    return input.value;
  }
  if (name === "UtcOffset") {
    if (input.kind !== "string" || !/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/u.test(input.value)) fail("argument_type_invalid", `${metadata.name} requires a UTC offset such as +10:00.`);
    return input.value;
  }
  if (["String", "ARN", "FormattedString", "HTML", "StorefrontID"].includes(name)) {
    if (input.kind !== "string") fail("argument_type_invalid", `${metadata.name} requires a string value.`);
    if (/\p{Cc}/u.test(input.value)) fail("argument_control_character", `${metadata.name} cannot contain control characters.`);
    return input.value;
  }
  fail("argument_scalar_unsupported", `Registry scalar ${name} has no admitted argument representation.`);
}

function decodeArgument(
  input: ShopifyAdminArgumentValue,
  typeRef: string,
  metadata: ShopifyGraphQLInputValue,
  index: ShopifyAdminGraphQLSchemaIndex,
): unknown {
  const ref = parseTypeRef(typeRef);
  const decode = (value: ShopifyAdminArgumentValue, current: TypeRef, meta: ShopifyGraphQLInputValue): unknown => {
    if (value.kind === "null") {
      if (current.nonNull) fail("argument_null_invalid", `${meta.name} is non-null.`);
      return null;
    }
    if (current.kind === "list") {
      if (value.kind !== "list") fail("argument_type_invalid", `${meta.name} requires a list.`);
      return value.values.map((entry) => decode(entry, current.item, meta));
    }
    const definition = index.typesByName.get(current.name);
    if (!definition) fail("registry_type_unknown", `Registry input type ${current.name} is unknown.`);
    if (definition.kind === "SCALAR") return decodeScalar(value, current.name, meta);
    if (definition.kind === "ENUM") {
      if (value.kind !== "enum") fail("argument_type_invalid", `${meta.name} requires enum ${current.name}.`);
      const option = definition.enumValues?.find(({ name }) => name === value.value);
      if (!option || option.isPrivatelyDocumented) fail("argument_enum_invalid", `${value.value} is not a public ${current.name} option.`);
      return value.value;
    }
    if (definition.kind === "INPUT_OBJECT") {
      if (value.kind !== "object") fail("argument_type_invalid", `${meta.name} requires input object ${current.name}.`);
      const names = value.fields.map(({ name }) => name);
      if (new Set(names).size !== names.length) fail("argument_field_duplicate", `${meta.name} contains duplicate input fields.`);
      const fields = new Map((definition.inputFields ?? []).map((field) => [field.name, field] as const));
      const output: Record<string, unknown> = {};
      for (const entry of value.fields) {
        const field = fields.get(entry.name);
        if (!field) fail("argument_field_unknown", `${entry.name} is not a field of ${current.name}.`);
        output[entry.name] = decode(entry.value, parseTypeRef(field.type), field);
      }
      for (const field of definition.inputFields ?? []) {
        if (field.type.endsWith("!") && field.defaultValue === null && !Object.hasOwn(output, field.name)) {
          fail("argument_required_missing", `${meta.name}.${field.name} is required.`);
        }
      }
      return output;
    }
    fail("argument_type_invalid", `${current.name} is not a GraphQL input type.`);
  };
  return decode(input, ref, metadata);
}

const availability = new Map(SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.map((entry) => [entry.schemaPath, entry] as const));

function scopes(value: string | undefined): readonly string[] {
  return value?.match(/\bread_[a-z0-9_]+\b/gu) ?? [];
}

/**
 * Shopify expresses access requirements as prose. The committed registry is
 * still the only authority: this parser recognizes only the conjunction and
 * disjunction forms present in that registry. Anything ambiguous remains an
 * all-of requirement, which can deny a query but can never under-authorize it.
 */
function scopeGroups(value: string | undefined): readonly (readonly string[])[] {
  if (!value) return [];
  const groups: string[][] = [];
  for (const clause of value.replace(/\s+/gu, " ").split(/\.\s+Also:\s*/iu)) {
    const found = [...new Set(scopes(clause))];
    if (found.length === 0) continue;
    const parenthesized = /^(.*?)\band\s*\((.*\bor\b.*)\)/iu.exec(clause);
    if (parenthesized) {
      scopes(parenthesized[1]).forEach((scope) => groups.push([scope]));
      const alternatives = [...new Set(scopes(parenthesized[2]))];
      if (alternatives.length > 0) groups.push(alternatives);
      continue;
    }
    if (/\bor\b/iu.test(clause) && !/\band\b/iu.test(clause)) {
      groups.push(found);
      continue;
    }
    found.forEach((scope) => groups.push([scope]));
  }
  const unique = new Map(groups.map((group) => {
    const normalized = [...new Set(group)].sort();
    return [normalized.join("|"), normalized] as const;
  }));
  return [...unique.values()];
}

const CREDENTIAL_BEARING_MEMBERS = new Set([
  "App.apiKey",
  "AppDiscountType.appKey",
  "DelegateAccessToken.accessToken",
  "Shop.analyticsToken",
  "Shop.storefrontAccessTokens",
  "ShopifyFunction.appKey",
  "ShopPayPaymentRequestReceipt.token",
  "StorefrontAccessToken.accessToken",
]);

const CREDENTIAL_BEARING_OUTPUT_TYPES = new Set([
  "DelegateAccessToken",
  "ShopPayPaymentRequestReceipt",
  "StorefrontAccessToken",
  "StorefrontAccessTokenConnection",
]);

function appOwnershipLimited(value: string): boolean {
  return /(?:owned|created|provided|managed) by (?:this|the requesting|your) app|app-owned|current app(?:lication)? only/iu.test(value);
}

function terms(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter((term) => term.length >= 2))];
}

function fuzzyScore(query: readonly string[], value: string): number {
  const normalized = value.toLowerCase();
  return query.reduce((total, term) => total + (normalized === term ? 20 : normalized.includes(term) ? 5 : 0), 0);
}

const EXACT_PATH_SCORE = 1_000_000;
const EXACT_NAME_SCORE = 900_000;
const EXACT_TYPE_SCORE = 800_000;

/**
 * Exact registry identities must sort ahead of prose matches. Descriptions are
 * intentionally verbose and repeat common words such as "shop", "order" and
 * "return" thousands of times; fuzzy-only ranking can otherwise truncate the
 * exact member out of the bounded catalogue response.
 */
function adminTypeScore(
  rawQuery: string,
  queryTerms: readonly string[],
  type: ShopifyGraphQLType,
): number {
  const normalizedQuery = rawQuery.trim().toLowerCase();
  if (normalizedQuery === type.name.toLowerCase()) return EXACT_TYPE_SCORE;
  return fuzzyScore(queryTerms, `${type.name} ${type.description ?? ""}`);
}

function adminFieldScore(
  rawQuery: string,
  queryTerms: readonly string[],
  type: ShopifyGraphQLType,
  field: ShopifyGraphQLField,
): number {
  const normalizedQuery = rawQuery.trim().toLowerCase();
  const fieldName = field.name.toLowerCase();
  const schemaPath = `${type.name}.${field.name}`.toLowerCase();
  if (normalizedQuery === schemaPath) return EXACT_PATH_SCORE;
  if (normalizedQuery === fieldName) return EXACT_NAME_SCORE;
  return fuzzyScore(queryTerms, `${type.name} ${field.name} ${field.description ?? ""}`);
}

export function searchShopifyAdminCatalogue(value: unknown): Readonly<Record<string, unknown>> {
  const input: ShopifyAdminCatalogueInput = shopifyAdminCatalogueInputSchema.parse(value);
  const index = indexShopifyAdminSchemaRegistry();
  if (input.type && !index.typesByName.has(input.type)) fail("catalogue_type_unknown", `${input.type} is not in the Admin GraphQL 2026-07 registry.`);
  const queryTerms = terms(input.query);
  const limit = input.limit ?? 12;
  const candidateTypes = input.rootOnly
    ? [index.queryRoot]
    : input.type ? [index.typesByName.get(input.type)!] : index.document.types;
  const types = candidateTypes
    .map((type) => ({ type, score: adminTypeScore(input.query, queryTerms, type) }))
    .filter(({ score: valueScore }) => valueScore > 0 || Boolean(input.type))
    .sort((left, right) => right.score - left.score || left.type.name.localeCompare(right.type.name))
    .slice(0, limit)
    .map(({ type }) => ({
      name: type.name,
      kind: type.kind,
      description: type.description?.slice(0, 4_000) ?? null,
      possibleTypes: type.possibleTypes ?? [],
      protected: Boolean(type.isProtected),
      requiredAccess: type.requiredAccess ?? null,
      privatelyDocumented: Boolean(type.isPrivatelyDocumented),
    }));
  const fields = candidateTypes
    .flatMap((type) => (type.fields ?? []).map((field) => ({ type, field })))
    .map((entry) => ({
      ...entry,
      score: adminFieldScore(input.query, queryTerms, entry.type, entry.field),
    }))
    .filter(({ score: valueScore }) => valueScore > 0 || Boolean(input.type))
    .sort((left, right) => right.score - left.score || `${left.type.name}.${left.field.name}`.localeCompare(`${right.type.name}.${right.field.name}`))
    .slice(0, limit)
    .map(({ type, field }) => ({
      path: `${type.name}.${field.name}`,
      parentType: type.name,
      name: field.name,
      type: field.type,
      description: field.description?.slice(0, 4_000) ?? null,
      arguments: field.args.map((argument) => ({
        name: argument.name,
        type: argument.type,
        defaultValue: argument.defaultValue,
        gidTypes: argument.gidTypes ?? [],
      })),
      deprecated: field.isDeprecated,
      deprecationReason: field.deprecationReason ?? null,
      protected: Boolean(type.isProtected || field.isProtected),
      requiredAccess: [type.requiredAccess, field.requiredAccess].filter(Boolean),
      availability: availability.get(`${type.name}.${field.name}`)?.availability ?? "runtime_observation_required",
    }));
  return Object.freeze({
    apiVersion: index.document.apiVersion,
    registrySha256: index.document.source.schemaSha256,
    counts: index.document.counts,
    types,
    fields,
    guidance: "Use exact public registry names only. An exact Type.field path or parent-scoped field name is deterministically ranked first. Select a QueryRoot field, supply registry-typed arguments, and recursively select output fields. Connections require an explicit forward first page size.",
  });
}

export function compileShopifyAdminQuery(value: unknown): ShopifyAdminCompiledQuery {
  const parsed = shopifyAdminQueryInputSchema.safeParse(value);
  if (!parsed.success) fail("query_ir_invalid", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const input = parsed.data;
  const index = indexShopifyAdminSchemaRegistry();
  if (input.rootField === "shopifyqlQuery") {
    fail("root_field_separate_plane", "shopifyqlQuery is available only through the separately governed ShopifyQL compiler.");
  }
  if (input.rootField === "node" || input.rootField === "nodes") {
    fail("raw_node_lookup_excluded", "Generic node lookups are excluded; use the exact registered resource lookup so access and protection can be proven.");
  }
  const root = shopifyGraphQLField(index, index.queryRoot.name, input.rootField);
  if (!root) fail("root_field_unknown", `${input.rootField} is not a QueryRoot field in Admin GraphQL 2026-07.`);

  const variableDefinitions: string[] = [];
  const variables: Record<string, unknown> = {};
  const requiredScopes = new Set<string>();
  const requiredScopeGroups = new Map<string, readonly string[]>();
  const limitations = new Set<string>();
  const definitions: ShopifyAdminCompiledQuery["definitions"][number][] = [];
  const selectedPaths: string[] = [];
  let variableIndex = 0;
  let selectedFieldCount = 0;
  let nodeExposure = 0;
  let requiresLevel2 = false;

  const registerAccess = (parent: ShopifyGraphQLType, field: ShopifyGraphQLField, output: ShopifyGraphQLType, path: string) => {
    const schemaPath = `${parent.name}.${field.name}`;
    if (CREDENTIAL_BEARING_MEMBERS.has(schemaPath) || CREDENTIAL_BEARING_OUTPUT_TYPES.has(output.name)) {
      fail(
        "credential_bearing_member_excluded",
        `${path} can disclose an application credential, access token, receipt token, or credential-bearing object and is excluded from live execution.`,
      );
    }
    if (
      (parent.name === "Metafield" && ["value", "jsonValue", "compareDigest"].includes(field.name))
      || output.name === "JSON"
    ) {
      fail(
        "unclassified_literal_excluded",
        `${path} can contain unclassified merchant literals or raw payload data and has no operator-approved live disclosure purpose.`,
      );
    }
    if (
      parent.name.endsWith("Payload") || output.name.endsWith("Payload")
      || (parent.name === "OnlineStoreThemeFile" && field.name === "body")
    ) {
      fail("raw_payload_excluded", `${path} is a mutation/raw payload surface and is excluded from the read plane.`);
    }
    if (parent.isPrivatelyDocumented || field.isPrivatelyDocumented || output.isPrivatelyDocumented) {
      fail("member_privately_documented", `${path} is privately documented and cannot be queried through Albert.`);
    }
    if (parent.accessRestricted || field.accessRestricted || output.accessRestricted) {
      fail("member_access_restricted", `${path} is marked access restricted by Shopify.`);
    }
    if (parent.isProtected || field.isProtected || output.isProtected) {
      fail(
        "protected_live_execution_unavailable",
        `${path} is protected customer data. Its official definition remains searchable, but live values are disabled until a reviewed no-retain/export-complete result path exists.`,
      );
    }
    [parent.requiredAccess, field.requiredAccess, output.requiredAccess].forEach((access) => {
      scopes(access).forEach((scope) => requiredScopes.add(scope));
      scopeGroups(access).forEach((group) => requiredScopeGroups.set(group.join("|"), group));
      if (access) limitations.add(access.slice(0, 1_000));
    });
    const accessText = `${parent.description ?? ""} ${field.description ?? ""} ${output.description ?? ""} ${parent.requiredAccess ?? ""} ${field.requiredAccess ?? ""} ${output.requiredAccess ?? ""}`;
    if (appOwnershipLimited(accessText)) {
      limitations.add(`${path} is limited by Shopify to resources owned, created, provided, or managed by the current Albert app.`);
    }
    requiresLevel2 ||= Boolean(parent.isProtected || field.isProtected || output.isProtected);
    selectedFieldCount += 1;
    if (selectedFieldCount > SHOPIFY_ADMIN_MAX_SELECTED_FIELDS) {
      fail("selection_field_limit", `A query can select at most ${SHOPIFY_ADMIN_MAX_SELECTED_FIELDS} registry fields.`);
    }
    selectedPaths.push(path);
    definitions.push({
      path,
      parentType: parent.name,
      field: field.name,
      type: field.type,
      description: field.description?.slice(0, 4_000) ?? null,
      deprecated: field.isDeprecated,
      protected: Boolean(parent.isProtected || field.isProtected || output.isProtected),
      requiredAccess: ([parent.requiredAccess, field.requiredAccess, output.requiredAccess]
        .filter(Boolean).join(" Also: ").slice(0, 4_000) || null),
    });
  };

  const compileArguments = (
    field: ShopifyGraphQLField,
    provided: readonly Readonly<{ name: string; value: ShopifyAdminArgumentValue }>[] | null | undefined,
  ): Readonly<{ text: string; first: number | null }> => {
    const entries = provided ?? [];
    const names = entries.map(({ name }) => name);
    if (new Set(names).size !== names.length) fail("argument_duplicate", `${field.name} contains duplicate arguments.`);
    const metadata = new Map(field.args.map((argument) => [argument.name, argument] as const));
    for (const argument of field.args) {
      if (argument.type.endsWith("!") && argument.defaultValue === null && !names.includes(argument.name)) {
        fail("argument_required_missing", `${field.name}.${argument.name} is required.`);
      }
    }
    let first: number | null = null;
    const rendered = entries.map((entry) => {
      const argument = metadata.get(entry.name);
      if (!argument) fail("argument_unknown", `${entry.name} is not an argument of ${field.name}.`);
      if (entry.name === "last" || entry.name === "before") {
        fail("backward_pagination_unsupported", "The live Admin plane permits bounded forward pagination only.");
      }
      if (entry.name === "query") {
        fail(
          "opaque_search_query_excluded",
          `${field.name}.query is an opaque Shopify search language and is not admitted by the typed Admin IR.`,
        );
      }
      const decoded = decodeArgument(entry.value, argument.type, argument, index);
      if (entry.name === "first") {
        if (typeof decoded !== "number" || !Number.isInteger(decoded) || decoded < 1 || decoded > 50) {
          fail("page_size_invalid", "Connection first must be an integer between 1 and 50.");
        }
        first = decoded;
      }
      const variable = `v${variableIndex++}`;
      variableDefinitions.push(`$${variable}: ${argument.type}`);
      variables[variable] = decoded;
      return `${entry.name}: $${variable}`;
    });
    return { text: rendered.length ? `(${rendered.join(", ")})` : "", first };
  };

  const compileSelections = (
    parent: ShopifyGraphQLType,
    selections: readonly ShopifyAdminSelection[],
    path: string,
    depth: number,
    multiplier: number,
  ): string => {
    if (depth > SHOPIFY_ADMIN_MAX_SELECTION_DEPTH) fail("selection_depth_limit", `Selections are limited to depth ${SHOPIFY_ADMIN_MAX_SELECTION_DEPTH}.`);
    const names = selections.map(({ field }) => field);
    if (new Set(names).size !== names.length) fail("selection_duplicate", `${path} contains duplicate fields.`);
    return selections.map((selection) => {
      const field = parent.fields?.find(({ name }) => name === selection.field);
      if (!field) fail("selection_field_unknown", `${parent.name}.${selection.field} is not in the Admin GraphQL 2026-07 registry.`);
      const outputName = shopifyGraphQLNamedType(field.type);
      const output = index.typesByName.get(outputName);
      if (!output) fail("registry_type_unknown", `Output type ${outputName} is missing from the registry.`);
      const fieldPath = `${path}.${selection.field}`;
      registerAccess(parent, field, output, fieldPath);
      const args = compileArguments(field, selection.arguments);
      const composite = ["OBJECT", "INTERFACE", "UNION"].includes(output.kind);
      if (!composite && ((selection.select?.length ?? 0) > 0 || (selection.on?.length ?? 0) > 0)) {
        fail("leaf_subselection_invalid", `${fieldPath} is a leaf field and cannot have a selection.`);
      }
      if (composite && (selection.select?.length ?? 0) === 0 && (selection.on?.length ?? 0) === 0) {
        fail("composite_subselection_required", `${fieldPath} requires a nested selection.`);
      }
      const connection = output.kind === "OBJECT"
        && Boolean(output.fields?.some(({ name }) => name === "pageInfo"))
        && Boolean(output.fields?.some(({ name }) => name === "nodes" || name === "edges"));
      let nextMultiplier = multiplier;
      if (connection) {
        if (args.first === null) fail("connection_first_required", `${fieldPath} requires an explicit bounded first argument.`);
        nextMultiplier *= args.first;
        nodeExposure += nextMultiplier;
        if (nodeExposure > SHOPIFY_ADMIN_MAX_NODE_EXPOSURE) {
          fail("node_exposure_limit", `Connection selections can expose at most ${SHOPIFY_ADMIN_MAX_NODE_EXPOSURE} nodes per call.`);
        }
      } else if (field.type.includes("[") && composite) {
        nextMultiplier *= 10;
      }
      const blocks: string[] = [];
      if (selection.select?.length) {
        if (output.kind === "UNION") fail("union_fragment_required", `${fieldPath} is a union and accepts only registered type fragments.`);
        blocks.push(compileSelections(output, selection.select, fieldPath, depth + 1, nextMultiplier));
      }
      if (selection.on?.length) {
        if (output.kind !== "INTERFACE" && output.kind !== "UNION") {
          fail("fragment_parent_invalid", `${fieldPath} is not an interface or union.`);
        }
        const fragmentTypes = selection.on.map(({ type }) => type);
        if (new Set(fragmentTypes).size !== fragmentTypes.length) fail("fragment_duplicate", `${fieldPath} contains duplicate type fragments.`);
        blocks.push("__typename");
        for (const fragment of selection.on) {
          if (!output.possibleTypes?.includes(fragment.type)) {
            fail("fragment_type_invalid", `${fragment.type} is not a possible type of ${output.name}.`);
          }
          const concrete = index.typesByName.get(fragment.type);
          if (!concrete || concrete.kind !== "OBJECT") fail("fragment_type_invalid", `${fragment.type} is not a public object type.`);
          const body = compileSelections(concrete, fragment.select, `${fieldPath}.$on.${fragment.type}`, depth + 1, nextMultiplier);
          blocks.push(`... on ${fragment.type} { ${body} }`);
        }
      }
      return `${selection.field}${args.text}${composite ? ` { ${blocks.join(" ")} }` : ""}`;
    }).join(" ");
  };

  const compiledRoot = compileSelections(index.queryRoot, [{
    field: root.name,
    ...(input.arguments ? { arguments: input.arguments } : {}),
    ...(input.select ? { select: input.select } : {}),
    ...(input.on ? { on: input.on } : {}),
  }], "QueryRoot", 0, 1);
  const declarations = variableDefinitions.length ? `(${variableDefinitions.join(", ")})` : "";
  const query = `query AlbertShopifyAdmin${declarations} { _albertAccess: currentAppInstallation { accessScopes { handle } } result: ${compiledRoot} }`;
  const queryDigest = createHash("sha256")
    .update(JSON.stringify({ query, variables }))
    .digest("hex");
  return Object.freeze({
    apiVersion: SHOPIFY_ADMIN_API_VERSION,
    registrySha256: index.document.source.schemaSha256,
    query,
    variables: Object.freeze(variables),
    queryDigest,
    normalizedInput: input,
    rootField: root.name,
    selectedPaths: Object.freeze(selectedPaths),
    requiredScopes: Object.freeze([...requiredScopes].sort()),
    requiredScopeGroups: Object.freeze([...requiredScopeGroups.values()]
      .map((group) => Object.freeze([...group]))
      .sort((left, right) => left.join("|").localeCompare(right.join("|")))),
    requiresLevel2,
    accessLimitations: Object.freeze([...limitations]),
    definitions: Object.freeze(definitions),
  });
}

export function countShopifyAdminResultLeaves(value: unknown): number {
  if (value === null || typeof value !== "object") return 1;
  if (Array.isArray(value)) return value.reduce<number>((total, entry) => total + countShopifyAdminResultLeaves(entry), 0);
  return Object.values(value as Readonly<Record<string, unknown>>)
    .reduce<number>((total, entry) => total + countShopifyAdminResultLeaves(entry), 0);
}
