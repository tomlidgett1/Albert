import { createHash } from "node:crypto";

import {
  SHOPIFYQL_MAX_QUERY_BYTES,
  SHOPIFYQL_MAX_WINDOW_DAYS,
  shopifyQLCatalogueInputSchema,
  shopifyQLQueryInputSchema,
  type ShopifyQLCatalogueInput,
  type ShopifyQLCondition,
  type ShopifyQLMatchCondition,
  type ShopifyQLQueryInput,
} from "../../packages/shopifyql/src/contract.js";
import {
  indexShopifyQLSchemaRegistry,
  shopifyQLMatchExpression,
  type ShopifyQLField,
  type ShopifyQLResolvedField,
  type ShopifyQLSchemaFieldIndex,
} from "./shopifyql-registry.js";
import {
  auditShopifyQLPrivacyRegistry,
  classifyShopifyQLPrivacyField,
  classifyShopifyQLPrivacyMatchField,
  SHOPIFYQL_PRIVACY_POLICY_VERSION,
  SHOPIFYQL_PRIVACY_REVIEWED_COUNTS,
} from "./shopifyql-privacy-policy.js";

const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_$-]+)*$/u;

const OPERATOR_SYNTAX = Object.freeze({
  equals: { official: "equals", token: "=", arity: 1 },
  not_equals: { official: "not equals", token: "!=", arity: 1 },
  greater_than: { official: "greater than", token: ">", arity: 1 },
  greater_than_or_equal: { official: "greater than or equal", token: ">=", arity: 1 },
  less_than: { official: "less than", token: "<", arity: 1 },
  less_than_or_equal: { official: "less than or equal", token: "<=", arity: 1 },
  between: { official: "BETWEEN", token: "BETWEEN", arity: 2 },
  not_between: { official: "NOT BETWEEN", token: "NOT BETWEEN", arity: 2 },
  in: { official: "IN", token: "IN", arity: "many" },
  not_in: { official: "NOT IN", token: "NOT IN", arity: "many" },
  contains: { official: "CONTAINS", token: "CONTAINS", arity: 1 },
  not_contains: { official: "NOT CONTAINS", token: "NOT CONTAINS", arity: 1 },
  starts_with: { official: "STARTS WITH", token: "STARTS WITH", arity: 1 },
  ends_with: { official: "ENDS WITH", token: "ENDS WITH", arity: 1 },
  is_null: { official: "IS NULL", token: "IS NULL", arity: 0 },
  is_not_null: { official: "IS NOT NULL", token: "IS NOT NULL", arity: 0 },
  is_true: { official: "IS TRUE", token: "IS TRUE", arity: 0 },
  is_not_true: { official: "IS NOT TRUE", token: "IS NOT TRUE", arity: 0 },
  is_false: { official: "IS FALSE", token: "IS FALSE", arity: 0 },
  is_not_false: { official: "IS NOT FALSE", token: "IS NOT FALSE", arity: 0 },
} as const);

const MODIFIER_SYNTAX = Object.freeze({
  cumulative_values: "CUMULATIVE_VALUES",
  group_totals: "GROUP_TOTALS",
  percent_change: "PERCENT_CHANGE",
  totals: "TOTALS",
} as const);

const ATTRIBUTION_SYNTAX = Object.freeze({
  first_click: "FIRST_CLICK_ATTRIBUTION",
  last_click: "LAST_CLICK_ATTRIBUTION",
  last_non_direct_click: "LAST_NON_DIRECT_CLICK_ATTRIBUTION",
  any_click: "ANY_CLICK_ATTRIBUTION",
  linear: "LINEAR_ATTRIBUTION",
} as const);

export class ShopifyQLPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ShopifyQLPolicyError";
  }
}

export type ShopifyQLCompiledQuery = Readonly<{
  apiVersion: "2026-07";
  registrySha256: string;
  query: string;
  queryDigest: string;
  normalizedInput: ShopifyQLQueryInput;
  schema: string;
  metrics: readonly string[];
  dimensions: readonly string[];
  deprecatedFields: readonly string[];
  definitions: readonly Readonly<{
    name: string;
    kind: "metric" | "dimension" | "metafield";
    type: string;
    description: string;
    formula: string | null;
    deprecated: boolean;
  }>[];
}>;

function fail(code: string, message: string): never {
  throw new ShopifyQLPolicyError(code, message);
}

function parseDate(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day
  ) fail("time_window_invalid", `${value} is not a calendar date.`);
  return timestamp;
}

function validateTimeWindow(input: ShopifyQLQueryInput): void {
  const since = parseDate(input.timeWindow.since);
  const until = parseDate(input.timeWindow.until);
  if (until < since) fail("time_window_invalid", "ShopifyQL until must not precede since.");
  const inclusiveDays = Math.floor((until - since) / 86_400_000) + 1;
  if (inclusiveDays > SHOPIFYQL_MAX_WINDOW_DAYS) {
    fail(
      "time_window_too_wide",
      `A ShopifyQL query is limited to ${SHOPIFYQL_MAX_WINDOW_DAYS} inclusive days. Split the analysis into bounded periods.`,
    );
  }
}

function metafieldPattern(schemaPatterns: readonly string[], field: string): string | null {
  for (const pattern of schemaPatterns) {
    const regex = new RegExp(`^${pattern
      .replaceAll(".", "\\.")
      .replace("<namespace>", "[a-zA-Z0-9_$-]{1,255}")
      .replace("<key>", "[a-zA-Z0-9_-]{1,64}")}$`, "u");
    if (regex.test(field)) return pattern;
  }
  return null;
}

type Resolved = Readonly<{
  name: string;
  kind: "metric" | "dimension" | "metafield";
  field?: ShopifyQLField;
  type: string;
  description: string;
  formula: string | null;
  deprecated: boolean;
}>;

function resolveField(
  schema: ShopifyQLSchemaFieldIndex,
  name: string,
): Resolved {
  if (!FIELD_PATTERN.test(name)) fail("field_invalid", `ShopifyQL field ${name} is not a safe identifier.`);
  const exact = schema.metricsByName.get(name)
    ? ({ kind: "metric", field: schema.metricsByName.get(name)! } as ShopifyQLResolvedField)
    : schema.dimensionsByName.get(name)
      ? ({ kind: "dimension", field: schema.dimensionsByName.get(name)! } as ShopifyQLResolvedField)
      : undefined;
  if (exact) {
    return {
      name,
      kind: exact.kind,
      field: exact.field,
      type: exact.field.type,
      description: exact.field.description,
      formula: exact.field.formula ?? null,
      deprecated: exact.field.isDeprecated,
    };
  }
  const pattern = metafieldPattern(schema.schema.queryableMetafieldPatterns, name);
  if (pattern) {
    return {
      name,
      kind: "metafield",
      type: "METAFIELD",
      description: `Merchant-defined Shopify metafield matching the official ${pattern} query pattern.`,
      formula: null,
      deprecated: false,
    };
  }
  fail("field_unknown", `${name} is not documented for FROM ${schema.schema.name} in ShopifyQL 2026-07.`);
}

const NUMERIC_TYPES = new Set([
  "ARRAY<FLOAT>", "ARRAY<INTEGER>", "DAY_DURATION", "DAY_OF_WEEK", "DECIMAL",
  "FLOAT", "HOUR_DURATION", "HOUR_OF_DAY", "INTEGER", "MILLISECOND_DURATION",
  "MONEY", "MONTH_OF_YEAR", "MULTIPLIER", "PERCENT", "SECOND_DURATION",
  "UNITLESS_SCALAR", "WEEK_OF_YEAR",
]);
const STRING_TYPES = new Set(["ARRAY<STRING>", "STRING"]);
const TIMESTAMP_TYPES = new Set([
  "DAY_TIMESTAMP", "HOUR_TIMESTAMP", "MINUTE_TIMESTAMP", "MONTH_TIMESTAMP",
  "QUARTER_TIMESTAMP", "SECOND_TIMESTAMP", "TIMESTAMP", "WEEK_TIMESTAMP",
  "YEAR_TIMESTAMP",
]);
const ABSOLUTE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;

function validateAbsoluteTimestamp(value: string): void {
  if (!ABSOLUTE_TIMESTAMP.test(value)) {
    fail("literal_type_invalid", "Timestamp fields require a strict absolute ISO date or timestamp.");
  }
  const day = value.slice(0, 10);
  parseDate(day);
  if (value.length > 10 && Number.isNaN(Date.parse(value))) {
    fail("literal_type_invalid", "Timestamp filter value is not a valid ISO timestamp.");
  }
}

function literal(value: string | number | boolean, type: string): string {
  if (type === "GEO_COORDINATE") {
    // Shopify documents the type but not a literal grammar in the pinned
    // source registry. Never guess a representation at a protected-data
    // execution boundary.
    fail("literal_type_unsupported", "GEO_COORDINATE has no documented ShopifyQL 2026-07 literal grammar.");
  }
  if (TIMESTAMP_TYPES.has(type)) {
    if (typeof value !== "string") {
      fail("literal_type_invalid", `${type} fields require an absolute ISO date or timestamp string.`);
    }
    validateAbsoluteTimestamp(value);
    // ShopifyQL date/timestamp literals are unquoted (for example,
    // `date > 2025-01-01`). The strict grammar above is the injection fence.
    return value;
  }
  if (type === "BOOLEAN") {
    if (typeof value !== "boolean") fail("literal_type_invalid", "BOOLEAN fields require boolean values.");
    return value ? "TRUE" : "FALSE";
  }
  if (type === "IDENTITY") {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        fail("literal_type_invalid", "IDENTITY fields require a non-negative integer identifier.");
      }
      return String(value);
    }
    if (typeof value === "string" && /^\d{1,30}$/u.test(value)) return value;
    fail("literal_type_invalid", "IDENTITY fields require a decimal Shopify identifier.");
  }
  if (NUMERIC_TYPES.has(type)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("literal_type_invalid", `${type} fields require finite numeric values.`);
    }
    return String(value);
  }
  if (STRING_TYPES.has(type)) {
    if (typeof value !== "string") fail("literal_type_invalid", `${type} fields require string values.`);
    if (/\p{Cc}/u.test(value)) fail("literal_invalid", "Filter strings cannot contain control characters.");
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (type === "METAFIELD") {
    fail("literal_type_unsupported", "A metafield's merchant-defined type cannot be proven from the public registry; use it only as a returned or grouped field.");
  }
  fail("literal_type_unsupported", `ShopifyQL literal rendering is not defined for registry type ${type}.`);
}

function assertOperatorDocumented(operator: keyof typeof OPERATOR_SYNTAX, scope: "where" | "having"): void {
  const registry = indexShopifyQLSchemaRegistry().document;
  const options = scope === "where" ? registry.syntax.whereOperators : registry.syntax.havingOperators;
  const official = OPERATOR_SYNTAX[operator].official;
  if (!options.some(({ name }) => name === official)) {
    fail("operator_not_documented", `${official} is not documented for ShopifyQL ${scope.toUpperCase()} 2026-07.`);
  }
}

function compileCondition(
  condition: ShopifyQLCondition | ShopifyQLMatchCondition,
  type: string,
  scope: "where" | "having",
): string {
  assertOperatorDocumented(condition.operator, scope);
  const syntax = OPERATOR_SYNTAX[condition.operator];
  const values = condition.values ?? [];
  if (syntax.arity === 0 && values.length !== 0) {
    fail("operator_arity_invalid", `${syntax.official} does not accept values.`);
  }
  if (syntax.arity === 1 && values.length !== 1) {
    fail("operator_arity_invalid", `${syntax.official} requires exactly one value.`);
  }
  if (syntax.arity === 2 && values.length !== 2) {
    fail("operator_arity_invalid", `${syntax.official} requires exactly two values.`);
  }
  if (syntax.arity === "many" && (values.length < 1 || values.length > 50)) {
    fail("operator_arity_invalid", `${syntax.official} requires between one and 50 values.`);
  }
  if (["is_true", "is_not_true", "is_false", "is_not_false"].includes(condition.operator) && type !== "BOOLEAN") {
    fail("operator_type_invalid", `${syntax.official} requires a BOOLEAN field.`);
  }
  if (["contains", "not_contains", "starts_with", "ends_with"].includes(condition.operator) && !STRING_TYPES.has(type)) {
    fail("operator_type_invalid", `${syntax.official} requires a string or string-array field.`);
  }
  const rendered = values.map((value) => literal(value, type));
  if (syntax.arity === 0) return `${condition.field} ${syntax.token}`;
  if (syntax.arity === 2) return `${condition.field} ${syntax.token} ${rendered[0]} AND ${rendered[1]}`;
  if (syntax.arity === "many") return `${condition.field} ${syntax.token} (${rendered.join(", ")})`;
  return `${condition.field} ${syntax.token} ${rendered[0]}`;
}

function joinConditions(values: readonly Readonly<{ join: "and" | "or"; clause: string }>[]): string {
  return values.map((value, index) => `${index === 0 ? "" : `${value.join.toUpperCase()} `}(${value.clause})`).join(" ");
}

function assertSyntaxOptions(input: ShopifyQLQueryInput): void {
  const registry = indexShopifyQLSchemaRegistry().document;
  if (input.timeseries && !registry.syntax.timeseries.some(({ name }) => name === input.timeseries)) {
    fail("timeseries_not_documented", `${input.timeseries} is not a ShopifyQL 2026-07 timeseries.`);
  }
  if (input.compareTo && !registry.syntax.relativeComparisons.some(({ name }) => name === input.compareTo)) {
    fail("comparison_not_documented", `${input.compareTo} is not a ShopifyQL 2026-07 comparison.`);
  }
  for (const modifier of input.modifiers ?? []) {
    const official = MODIFIER_SYNTAX[modifier];
    if (!registry.syntax.modifiers.some(({ name }) => name === official)) {
      fail("modifier_not_documented", `${official} is not a ShopifyQL 2026-07 modifier.`);
    }
  }
  if (input.currency && !registry.syntax.modifiers.some(({ name }) => name === "CURRENCY")) {
    fail("modifier_not_documented", "CURRENCY is not documented by the pinned registry.");
  }
  if (input.timezone && !registry.syntax.modifiers.some(({ name }) => name === "TIMEZONE")) {
    fail("modifier_not_documented", "TIMEZONE is not documented by the pinned registry.");
  }
  if (input.attributionModel) {
    const official = ATTRIBUTION_SYNTAX[input.attributionModel];
    if (!registry.syntax.attributionModels.some(({ name }) => name === official)) {
      fail("attribution_not_documented", `${official} is not a ShopifyQL 2026-07 attribution model.`);
    }
  }
}

export function compileShopifyQLQuery(value: unknown): ShopifyQLCompiledQuery {
  const parsed = shopifyQLQueryInputSchema.safeParse(value);
  if (!parsed.success) fail("query_ir_invalid", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const input = parsed.data;
  validateTimeWindow(input);
  assertSyntaxOptions(input);

  const index = indexShopifyQLSchemaRegistry();
  const privacyAudit = auditShopifyQLPrivacyRegistry(index.document);
  if (!privacyAudit.reviewed) {
    fail(
      "privacy_policy_registry_unreviewed",
      "A ShopifyQL definition or privacy decision changed after the exhaustive review. Review and reclassify the full registry before executing merchant queries.",
    );
  }
  const schema = index.schemasByName.get(input.schema);
  if (!schema) {
    const fromOnly = index.queryableSchemasByName.get(input.schema);
    fail(
      fromOnly?.documentationStatus === "from_only" ? "schema_fields_undocumented" : "schema_unknown",
      fromOnly
        ? `FROM ${input.schema} is named by Shopify but has no official 2026-07 field contract, so executable queries fail closed.`
        : `FROM ${input.schema} is not documented by ShopifyQL 2026-07.`,
    );
  }

  const resolved = new Map<string, Resolved>();
  const get = (name: string) => {
    const found = resolved.get(name) ?? resolveField(schema, name);
    const privacy = classifyShopifyQLPrivacyField(found);
    if (privacy.disposition === "denied") {
      fail(
        "field_protected",
        `${input.schema}.${name} is catalogue-searchable but cannot be executed: ${privacy.explanation}`,
      );
    }
    resolved.set(name, found);
    return found;
  };
  const selected = input.fields.map(get);
  if (new Set(input.fields).size !== input.fields.length) fail("field_duplicate", "ShopifyQL fields must be unique.");

  const groupBy = input.groupBy ?? [];
  if (new Set(groupBy).size !== groupBy.length) fail("group_by_duplicate", "GROUP BY fields must be unique.");
  for (const field of groupBy) {
    if (get(field).kind === "metric") fail("group_by_metric", `GROUP BY cannot use metric ${field}.`);
  }
  const timeseriesField = input.timeseries ? get(input.timeseries) : undefined;
  if (timeseriesField?.kind === "metric") {
    fail("timeseries_metric", `TIMESERIES ${input.timeseries!} is not a dimension in FROM ${input.schema}.`);
  }
  for (const field of selected) {
    if (
      field.kind !== "metric" && !groupBy.includes(field.name) &&
      field.name !== input.timeseries
    ) {
      fail(
        "show_dimension_not_grouped",
        `SHOW dimension ${field.name} must appear in GROUP BY or be the TIMESERIES dimension.`,
      );
    }
  }
  const where = (input.where ?? []).map((condition) => {
    const field = get(condition.field);
    if (field.kind === "metric") {
      fail("where_metric", `WHERE cannot filter metric ${field.name}; use HAVING or a documented MATCHES metric condition.`);
    }
    return { join: condition.join ?? "and", clause: compileCondition(condition, field.type, "where") } as const;
  });
  const having = (input.having ?? []).map((condition) => {
    const field = get(condition.field);
    if (!input.groupBy?.length && !input.timeseries) {
      fail("having_requires_aggregation", "HAVING requires GROUP BY or TIMESERIES.");
    }
    const returned = field.kind === "metric"
      ? input.fields.includes(field.name)
      : input.fields.includes(field.name) || groupBy.includes(field.name) || input.timeseries === field.name;
    if (!returned) fail("having_field_not_returned", `HAVING field ${field.name} must be part of the query result.`);
    return { join: condition.join ?? "and", clause: compileCondition(condition, field.type, "having") } as const;
  });
  const matches = (input.matches ?? []).map((match) => {
    const documented = shopifyQLMatchExpression(index, input.schema, match.expression);
    if (!documented) fail("match_expression_unknown", `${match.expression} is not documented for FROM ${input.schema}.`);
    const official = match.operator === "matches" ? "MATCHES" : "NOT MATCHES";
    if (!index.document.syntax.matchOperators.some(({ name }) => name === official)) {
      fail("match_operator_not_documented", `${official} is not documented by ShopifyQL 2026-07.`);
    }
    const fields = new Map(documented.condition.fields.map((field) => [field.name, field] as const));
    const parameterNames = match.conditions.map(({ field }) => field);
    if (new Set(parameterNames).size !== parameterNames.length) {
      fail("match_condition_duplicate", `Each field can be used only once inside ${match.expression} MATCHES.`);
    }
    if (
      fields.has("coordinates") && fields.has("distance_km") && fields.has("distance_mi")
    ) {
      const distanceUnits = Number(parameterNames.includes("distance_km")) +
        Number(parameterNames.includes("distance_mi"));
      if (!parameterNames.includes("coordinates") || distanceUnits !== 1) {
        fail(
          "match_required_conditions_missing",
          `${match.expression} requires coordinates and exactly one of distance_km or distance_mi.`,
        );
      }
    }
    const conditions = match.conditions.map((condition) => {
      const field = fields.get(condition.field);
      if (!field) fail("match_condition_unknown", `${condition.field} is not valid inside ${match.expression}.`);
      const privacy = classifyShopifyQLPrivacyMatchField(field);
      if (privacy.disposition === "denied") {
        fail(
          "match_condition_protected",
          `${input.schema}.${match.expression}.${condition.field} cannot be executed: ${privacy.explanation}`,
        );
      }
      return compileCondition(condition, field.type, field.role === "metric" ? "having" : "where");
    });
    // Official MATCHES parameters use commas; AND/OR is invalid here.
    return { join: match.join ?? "and", clause: `${match.expression} ${official} (${conditions.join(", ")})` } as const;
  });

  for (const order of input.orderBy ?? []) {
    get(order.field);
    if (!input.fields.includes(order.field) && !groupBy.includes(order.field) && input.timeseries !== order.field) {
      fail("order_field_not_returned", `ORDER BY field ${order.field} must be selected, grouped, or supplied by TIMESERIES.`);
    }
  }
  if (input.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); } catch {
      fail("timezone_invalid", `${input.timezone} is not an IANA timezone.`);
    }
  }

  const clauses = [`FROM ${input.schema}`, `SHOW ${input.fields.join(", ")}`];
  const predicates = [...where, ...matches];
  if (predicates.length > 0) clauses.push(`WHERE ${joinConditions(predicates)}`);
  if (groupBy.length) clauses.push(`GROUP BY ${groupBy.join(", ")}`);
  if (input.timeseries) clauses.push(`TIMESERIES ${input.timeseries}`);
  const modifiers = [
    ...(input.modifiers ?? []).map((modifier) => MODIFIER_SYNTAX[modifier]),
    ...(input.attributionModel ? [ATTRIBUTION_SYNTAX[input.attributionModel]] : []),
    ...(input.currency ? [`CURRENCY '${input.currency}'`] : []),
    ...(input.timezone ? [`TIMEZONE '${input.timezone.replaceAll("'", "''")}'`] : []),
  ];
  if (modifiers.length) clauses.push(`WITH ${[...new Set(modifiers)].join(", ")}`);
  if (having.length) clauses.push(`HAVING ${joinConditions(having)}`);
  clauses.push(`SINCE ${input.timeWindow.since}`, `UNTIL ${input.timeWindow.until}`);
  if (input.compareTo) clauses.push(`COMPARE TO ${input.compareTo}`);
  if (input.orderBy?.length) {
    clauses.push(`ORDER BY ${input.orderBy.map(({ field, direction }) => `${field} ${direction.toUpperCase()}`).join(", ")}`);
  }
  clauses.push(`LIMIT ${input.limit ?? 100}`);
  const query = clauses.join("\n");
  if (Buffer.byteLength(query, "utf8") > SHOPIFYQL_MAX_QUERY_BYTES) {
    fail("query_too_large", `Compiled ShopifyQL exceeds ${SHOPIFYQL_MAX_QUERY_BYTES} bytes.`);
  }

  const definitions = [...resolved.values()].map((field) => ({
    name: field.name,
    kind: field.kind,
    type: field.type,
    description: field.description,
    formula: field.formula,
    deprecated: field.deprecated,
  }));
  return Object.freeze({
    apiVersion: index.document.apiVersion,
    registrySha256: index.document.source.registrySha256,
    query,
    queryDigest: createHash("sha256").update(query).digest("hex"),
    normalizedInput: input,
    schema: input.schema,
    metrics: selected.filter(({ kind }) => kind === "metric").map(({ name }) => name),
    dimensions: selected.filter(({ kind }) => kind !== "metric").map(({ name }) => name),
    deprecatedFields: selected.filter(({ deprecated }) => deprecated).map(({ name }) => name),
    definitions,
  });
}

function terms(value: string): readonly string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter((term) => term.length >= 2))];
}

function fuzzyScore(queryTerms: readonly string[], text: string): number {
  const normalized = text.toLowerCase();
  return queryTerms.reduce((total, term) => total + (normalized === term ? 20 : normalized.includes(term) ? 5 : 0), 0);
}

const EXACT_QUALIFIED_FIELD_SCORE = 1_000_000;
const EXACT_FIELD_SCORE = 900_000;
const EXACT_SCHEMA_SCORE = 800_000;

function shopifyQLSchemaScore(
  rawQuery: string,
  queryTerms: readonly string[],
  schema: ShopifyQLSchemaFieldIndex["schema"],
): number {
  const normalizedQuery = rawQuery.trim().toLowerCase();
  if (normalizedQuery === schema.name.toLowerCase()) return EXACT_SCHEMA_SCORE;
  return fuzzyScore(queryTerms, `${schema.name} ${schema.domain} ${schema.description}`);
}

function shopifyQLFieldScore(
  rawQuery: string,
  queryTerms: readonly string[],
  schemaName: string,
  kind: "metric" | "dimension",
  field: ShopifyQLField,
): number {
  const normalizedQuery = rawQuery.trim().toLowerCase();
  const fieldName = field.name.toLowerCase();
  const qualifiedName = `${schemaName}.${field.name}`.toLowerCase();
  const registryPath = `shopifyql.${schemaName}.${kind}s.${field.name}`.toLowerCase();
  if (normalizedQuery === qualifiedName || normalizedQuery === registryPath) {
    return EXACT_QUALIFIED_FIELD_SCORE;
  }
  if (normalizedQuery === fieldName) return EXACT_FIELD_SCORE;
  return fuzzyScore(queryTerms, `${field.name} ${field.description} ${field.formula ?? ""}`);
}

/** Searches only the committed official registry; no merchant data or credentials are involved. */
export function searchShopifyQLCatalogue(value: unknown): Readonly<Record<string, unknown>> {
  const input: ShopifyQLCatalogueInput = shopifyQLCatalogueInputSchema.parse(value);
  const index = indexShopifyQLSchemaRegistry();
  const privacyAudit = auditShopifyQLPrivacyRegistry(index.document);
  const queryTerms = terms(input.query);
  const limit = input.limit ?? 12;
  const schemas = index.document.schemas
    .filter((schema) => !input.schema || schema.name === input.schema)
    .map((schema) => ({
      schema,
      score: shopifyQLSchemaScore(input.query, queryTerms, schema),
    }))
    .filter(({ score: valueScore }) => valueScore > 0 || input.schema)
    .sort((left, right) => right.score - left.score || left.schema.name.localeCompare(right.schema.name))
    .slice(0, limit)
    .map(({ schema }) => ({
      name: schema.name,
      domain: schema.domain,
      description: schema.description,
      queryableMetafieldPatterns: schema.queryableMetafieldPatterns,
      queryableMetafieldExecution: schema.queryableMetafieldPatterns.length > 0
        ? classifyShopifyQLPrivacyField({ kind: "metafield", name: "metafield", type: "METAFIELD" })
        : null,
      sourceUrl: schema.sourceUrl,
    }));
  const fields = index.document.schemas
    .filter((schema) => !input.schema || schema.name === input.schema)
    .flatMap((schema) => [
      ...schema.metrics.map((field) => ({ schema: schema.name, kind: "metric" as const, field })),
      ...schema.dimensions.map((field) => ({ schema: schema.name, kind: "dimension" as const, field })),
    ])
    .map((entry) => ({
      ...entry,
      score: shopifyQLFieldScore(
        input.query,
        queryTerms,
        entry.schema,
        entry.kind,
        entry.field,
      ),
    }))
    .filter(({ score: valueScore }) => valueScore > 0)
    .sort((left, right) => right.score - left.score || left.field.name.localeCompare(right.field.name))
    .slice(0, limit)
    .map(({ schema, kind, field }) => ({
      schema,
      name: field.name,
      kind,
      type: field.type,
      description: field.description,
      formula: field.formula ?? null,
      deprecated: field.isDeprecated,
      deprecationReason: field.deprecationReason ?? null,
      privacy: classifyShopifyQLPrivacyField({ kind, name: field.name, type: field.type }),
    }));
  const matches = index.document.schemas
    .filter((schema) => !input.schema || schema.name === input.schema)
    .flatMap((schema) => schema.matches.map((match) => ({
      schema: schema.name,
      ...match,
      condition: schema.matchConditions.find(({ name }) => name === match.type)!,
    })))
    .map((entry) => ({
      ...entry,
      score: fuzzyScore(queryTerms, [
        entry.name,
        entry.description,
        ...entry.condition.fields.flatMap((field) => [field.name, field.description]),
      ].join(" ")),
    }))
    .filter(({ score: valueScore }) => valueScore > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => ({
      schema: entry.schema,
      name: entry.name,
      type: entry.type,
      description: entry.description,
      condition: {
        ...entry.condition,
        fields: entry.condition.fields.map((field) => ({
          ...field,
          privacy: classifyShopifyQLPrivacyMatchField(field),
        })),
      },
    }));
  return Object.freeze({
    apiVersion: index.document.apiVersion,
    registrySha256: index.document.source.registrySha256,
    access: index.document.access,
    schemas,
    fields,
    matches,
    counts: index.document.counts,
    privacyPolicy: {
      version: SHOPIFYQL_PRIVACY_POLICY_VERSION,
      registryReviewed: privacyAudit.reviewed,
      classificationSha256: privacyAudit.classificationSha256,
      reviewedCounts: SHOPIFYQL_PRIVACY_REVIEWED_COUNTS,
    },
    guidance:
      "Definitions remain searchable. An exact schema.field name or full ShopifyQL registry path is deterministically ranked first. Execute only exact names marked privacy.disposition=allowed; denied fields never return merchant values.",
  });
}
