import registryJson from "./generated/shopifyql-2026-07.json" with { type: "json" };

export const SHOPIFYQL_API_VERSION = "2026-07" as const;

export type ShopifyQLField = Readonly<{
  name: string;
  type: string;
  description: string;
  formula?: string;
  isDeprecated: boolean;
  deprecationReason?: string;
}>;

export type ShopifyQLMatchField = Readonly<{
  name: string;
  role: "filter" | "metric";
  description: string;
  type: string;
}>;

export type ShopifyQLMatchCondition = Readonly<{
  name: string;
  description: string;
  fields: readonly ShopifyQLMatchField[];
}>;

export type ShopifyQLMatchExpression = Readonly<{
  name: string;
  type: string;
  description: string;
}>;

export type ShopifyQLSchema = Readonly<{
  name: string;
  domain: string;
  description: string;
  sourceUrl: string;
  sourceMarkdownUrl: string;
  metrics: readonly ShopifyQLField[];
  dimensions: readonly ShopifyQLField[];
  matches: readonly ShopifyQLMatchExpression[];
  matchConditions: readonly ShopifyQLMatchCondition[];
  queryableMetafieldPatterns: readonly string[];
  relatedSchemas: readonly string[];
}>;

export type ShopifyQLUndocumentedSchema = Readonly<{
  name: string;
  description: string;
}>;

export type ShopifyQLSyntaxOption = Readonly<{
  name: string;
  syntax: string;
  description: string;
}>;

export type ShopifyQLSyntaxTable = Readonly<{
  section: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}>;

export type ShopifyQLSyntaxDocument = Readonly<{
  slug: string;
  title: string;
  description: string;
  sourceUrl: string;
  sourceMarkdownUrl: string;
  grammar: readonly string[];
  options: readonly ShopifyQLSyntaxOption[];
  tables: readonly ShopifyQLSyntaxTable[];
}>;

export type ShopifyQLSchemaCounts = Readonly<{
  sourceDocuments: number;
  schemas: number;
  undocumentedSchemas: number;
  domains: number;
  metrics: number;
  dimensions: number;
  fields: number;
  deprecatedMetrics: number;
  deprecatedDimensions: number;
  formulas: number;
  dataTypes: number;
  matchExpressions: number;
  matchConditionTypes: number;
  matchConditionFields: number;
  queryableMetafieldPatterns: number;
  relatedSchemaLinks: number;
  syntaxDocuments: number;
  clauses: number;
  expressionOperators: number;
  whereOperators: number;
  havingOperators: number;
  whereFunctions: number;
  matchOperators: number;
  timeseriesDimensions: number;
  namedDateRanges: number;
  dateFunctions: number;
  relativeComparisons: number;
  modifiers: number;
  attributionModels: number;
  visualizationTypes: number;
  annotationTypes: number;
}>;

export type ShopifyQLSchemaRegistry = Readonly<{
  registryVersion: 1;
  apiVersion: typeof SHOPIFYQL_API_VERSION;
  source: Readonly<{
    provider: "Shopify";
    api: "ShopifyQL";
    apiVersion: typeof SHOPIFYQL_API_VERSION;
    documentationRoot: string;
    adminGraphqlDocumentationRoot: string;
    sourceDocuments: number;
    registrySha256: string;
  }>;
  counts: ShopifyQLSchemaCounts;
  access: Readonly<{
    graphqlField: "QueryRoot.shopifyqlQuery";
    requiredScope: "read_reports";
    protectedCustomerDataLevel: 2;
    description: string;
    executionDescription: string;
    sourceUrl: string;
    sourceMarkdownUrl: string;
  }>;
  schemaIndex: Readonly<{
    sourceUrl: string;
    sourceMarkdownUrl: string;
    domains: readonly string[];
  }>;
  schemas: readonly ShopifyQLSchema[];
  undocumentedSchemas: readonly ShopifyQLUndocumentedSchema[];
  dataTypes: readonly Readonly<{ name: string; description: string }>[];
  syntax: Readonly<{
    sourceUrl: string;
    sourceMarkdownUrl: string;
    clauses: readonly Readonly<{
      name: string;
      requirement: "required" | "conditional" | "optional";
      description: string;
    }>[];
    documents: readonly ShopifyQLSyntaxDocument[];
    expressionOperators: readonly ShopifyQLSyntaxOption[];
    whereOperators: readonly ShopifyQLSyntaxOption[];
    havingOperators: readonly ShopifyQLSyntaxOption[];
    whereFunctions: readonly Readonly<{
      name: string;
      syntax: string;
      description: string;
      supportedOperators: readonly string[];
    }>[];
    matchOperators: readonly ShopifyQLSyntaxOption[];
    timeseries: readonly Readonly<{
      name: string;
      format: string;
      description: string;
      defaultRange: string;
    }>[];
    namedDateRanges: readonly Readonly<{ name: string; description: string }>[];
    dateFunctions: readonly Readonly<{
      unit: string;
      syntax: string;
      description: string;
    }>[];
    relativeComparisons: readonly ShopifyQLSyntaxOption[];
    modifiers: readonly ShopifyQLSyntaxOption[];
    attributionModels: readonly Readonly<{
      name: string;
      description: string;
      columnSuffix?: string;
    }>[];
    visualizationTypes: readonly Readonly<{ name: string; description: string }>[];
    annotationTypes: readonly Readonly<{
      category: string;
      type: string;
      description: string;
      graphqlAdminOperations: readonly string[];
    }>[];
  }>;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegistryDocument(value: unknown): asserts value is ShopifyQLSchemaRegistry {
  if (!isRecord(value)) throw new Error("The ShopifyQL schema registry is not a JSON object.");
  if (value.registryVersion !== 1) {
    throw new Error(`Unsupported ShopifyQL registry version ${String(value.registryVersion)}.`);
  }
  if (value.apiVersion !== SHOPIFYQL_API_VERSION) {
    throw new Error(
      `ShopifyQL registry is pinned to ${String(value.apiVersion)}, expected ${SHOPIFYQL_API_VERSION}.`,
    );
  }
  if (!isRecord(value.source) || value.source.apiVersion !== value.apiVersion) {
    throw new Error("ShopifyQL source metadata does not match its API version.");
  }
  if (!Array.isArray(value.schemas) || value.schemas.length === 0) {
    throw new Error("ShopifyQL registry contains no documented schemas.");
  }
  if (!Array.isArray(value.undocumentedSchemas)) {
    throw new Error("ShopifyQL registry omits its FROM-only schema inventory.");
  }
  if (!isRecord(value.counts) || value.counts.schemas !== value.schemas.length) {
    throw new Error("ShopifyQL registry schema count does not match its payload.");
  }
  const undocumentedSchemaCount = value.counts.undocumentedSchemas;
  const fieldCount = value.counts.fields;
  const metricCount = value.counts.metrics;
  const dimensionCount = value.counts.dimensions;
  if (
    typeof undocumentedSchemaCount !== "number" ||
    typeof fieldCount !== "number" ||
    typeof metricCount !== "number" ||
    typeof dimensionCount !== "number" ||
    undocumentedSchemaCount !== value.undocumentedSchemas.length ||
    fieldCount !== metricCount + dimensionCount
  ) {
    throw new Error("ShopifyQL registry field or FROM-only counts are internally inconsistent.");
  }
  if (!isRecord(value.access) || value.access.requiredScope !== "read_reports") {
    throw new Error("ShopifyQL registry omits the documented read_reports access boundary.");
  }
}

const decodedRegistry: unknown = registryJson;
assertRegistryDocument(decodedRegistry);

/** Immutable 2026-07 ShopifyQL metadata generated only from official Shopify docs. */
export const SHOPIFYQL_SCHEMA_REGISTRY = decodedRegistry;

/** Returns the committed registry without network access or merchant credentials. */
export function loadShopifyQLSchemaRegistry(): ShopifyQLSchemaRegistry {
  return SHOPIFYQL_SCHEMA_REGISTRY;
}

export type ShopifyQLResolvedField = Readonly<
  | { kind: "metric"; field: ShopifyQLField }
  | { kind: "dimension"; field: ShopifyQLField }
>;

export type ShopifyQLSchemaFieldIndex = Readonly<{
  schema: ShopifyQLSchema;
  metricsByName: ReadonlyMap<string, ShopifyQLField>;
  dimensionsByName: ReadonlyMap<string, ShopifyQLField>;
  matchesByName: ReadonlyMap<string, ShopifyQLMatchExpression>;
  matchConditionsByName: ReadonlyMap<string, ShopifyQLMatchCondition>;
}>;

export type ShopifyQLQueryableSchema = Readonly<
  | {
      name: string;
      description: string;
      documentationStatus: "documented";
      schema: ShopifyQLSchema;
    }
  | {
      name: string;
      description: string;
      documentationStatus: "from_only";
    }
>;

export type ShopifyQLSchemaRegistryIndex = Readonly<{
  document: ShopifyQLSchemaRegistry;
  schemasByName: ReadonlyMap<string, ShopifyQLSchemaFieldIndex>;
  queryableSchemasByName: ReadonlyMap<string, ShopifyQLQueryableSchema>;
  dataTypesByName: ReadonlyMap<string, Readonly<{ name: string; description: string }>>;
  syntaxDocumentsBySlug: ReadonlyMap<string, ShopifyQLSyntaxDocument>;
}>;

function uniqueMap<T>(values: readonly T[], name: (value: T) => string, context: string): Map<string, T> {
  const result = new Map(values.map((value) => [name(value), value] as const));
  if (result.size !== values.length) throw new Error(`ShopifyQL registry contains duplicate ${context}.`);
  return result;
}

let defaultIndex: ShopifyQLSchemaRegistryIndex | undefined;

/** Builds and validates the lookup graph used by a ShopifyQL semantic planner. */
export function indexShopifyQLSchemaRegistry(
  document: ShopifyQLSchemaRegistry = SHOPIFYQL_SCHEMA_REGISTRY,
): ShopifyQLSchemaRegistryIndex {
  if (document === SHOPIFYQL_SCHEMA_REGISTRY && defaultIndex) return defaultIndex;
  const schemasByName = new Map<string, ShopifyQLSchemaFieldIndex>();
  const queryableSchemasByName = new Map<string, ShopifyQLQueryableSchema>();

  for (const schema of document.schemas) {
    const metricsByName = uniqueMap(schema.metrics, ({ name }) => name, `${schema.name} metrics`);
    const dimensionsByName = uniqueMap(
      schema.dimensions,
      ({ name }) => name,
      `${schema.name} dimensions`,
    );
    for (const metricName of metricsByName.keys()) {
      if (dimensionsByName.has(metricName)) {
        throw new Error(`ShopifyQL ${schema.name}.${metricName} is both a metric and a dimension.`);
      }
    }
    const matchesByName = uniqueMap(schema.matches, ({ name }) => name, `${schema.name} MATCHES expressions`);
    const matchConditionsByName = uniqueMap(
      schema.matchConditions,
      ({ name }) => name,
      `${schema.name} MATCHES condition types`,
    );
    for (const expression of schema.matches) {
      if (!matchConditionsByName.has(expression.type)) {
        throw new Error(
          `ShopifyQL ${schema.name}.${expression.name} points to missing condition type ${expression.type}.`,
        );
      }
    }
    const fieldIndex = {
      schema,
      metricsByName,
      dimensionsByName,
      matchesByName,
      matchConditionsByName,
    } satisfies ShopifyQLSchemaFieldIndex;
    if (schemasByName.has(schema.name)) throw new Error(`Duplicate ShopifyQL schema ${schema.name}.`);
    schemasByName.set(schema.name, fieldIndex);
    queryableSchemasByName.set(schema.name, {
      name: schema.name,
      description: schema.description,
      documentationStatus: "documented",
      schema,
    });
  }

  for (const schema of document.undocumentedSchemas) {
    if (queryableSchemasByName.has(schema.name)) {
      throw new Error(`ShopifyQL schema ${schema.name} is both documented and FROM-only.`);
    }
    queryableSchemasByName.set(schema.name, {
      ...schema,
      documentationStatus: "from_only",
    });
  }

  const index = {
    document,
    schemasByName,
    queryableSchemasByName,
    dataTypesByName: uniqueMap(document.dataTypes, ({ name }) => name, "data types"),
    syntaxDocumentsBySlug: uniqueMap(document.syntax.documents, ({ slug }) => slug, "syntax documents"),
  } satisfies ShopifyQLSchemaRegistryIndex;
  if (document === SHOPIFYQL_SCHEMA_REGISTRY) defaultIndex = index;
  return index;
}

/** Resolves a field only inside the schema selected by `FROM`. */
export function shopifyQLField(
  index: ShopifyQLSchemaRegistryIndex,
  schemaName: string,
  fieldName: string,
): ShopifyQLResolvedField | undefined {
  const schema = index.schemasByName.get(schemaName);
  if (!schema) return undefined;
  const metric = schema.metricsByName.get(fieldName);
  if (metric) return { kind: "metric", field: metric };
  const dimension = schema.dimensionsByName.get(fieldName);
  return dimension ? { kind: "dimension", field: dimension } : undefined;
}

/** Resolves a documented MATCHES expression and its parameter type. */
export function shopifyQLMatchExpression(
  index: ShopifyQLSchemaRegistryIndex,
  schemaName: string,
  expressionName: string,
): Readonly<{
  expression: ShopifyQLMatchExpression;
  condition: ShopifyQLMatchCondition;
}> | undefined {
  const schema = index.schemasByName.get(schemaName);
  const expression = schema?.matchesByName.get(expressionName);
  if (!schema || !expression) return undefined;
  const condition = schema.matchConditionsByName.get(expression.type);
  if (!condition) throw new Error(`ShopifyQL MATCHES condition ${expression.type} is missing.`);
  return { expression, condition };
}
