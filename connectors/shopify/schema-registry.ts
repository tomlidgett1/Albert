import registryJson from "./generated/admin-graphql-2026-07.json" with { type: "json" };

export const SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION = "2026-07" as const;

export type ShopifyGraphQLNamedTypeKind =
  | "SCALAR"
  | "OBJECT"
  | "INTERFACE"
  | "UNION"
  | "ENUM"
  | "INPUT_OBJECT";

export type ShopifyGraphQLAccessMetadata = Readonly<{
  /** Present only when Shopify marks the schema member as access restricted. */
  accessRestricted?: true;
  accessRestrictedReason?: string;
  /** Present only for protected customer data or another protected subject. */
  isProtected?: true;
  protectedSubject?: string;
  protectedContent?: string;
  /** Shopify's human-readable access-scope or staff-permission requirement. */
  requiredAccess?: string;
  isPrivatelyDocumented?: true;
}>;

export type ShopifyGraphQLInputValue = Readonly<{
  name: string;
  description: string | null;
  /** Fully rendered GraphQL type, for example `[ID!]!`. */
  type: string;
  /** GraphQL literal, or null when no default is declared. */
  defaultValue: string | null;
  isDeprecated: boolean;
  deprecationReason?: string;
  /** Shopify global-ID subjects accepted by an ID input, when documented. */
  gidTypes?: readonly string[];
}>;

export type ShopifyGraphQLField = ShopifyGraphQLAccessMetadata &
  Readonly<{
    name: string;
    description: string | null;
    /** Fully rendered GraphQL type, for example `ProductConnection!`. */
    type: string;
    args: readonly ShopifyGraphQLInputValue[];
    isDeprecated: boolean;
    deprecationReason?: string;
  }>;

export type ShopifyGraphQLEnumValue = Readonly<{
  name: string;
  description: string | null;
  isDeprecated: boolean;
  deprecationReason?: string;
  isPrivatelyDocumented?: true;
}>;

export type ShopifyGraphQLType = ShopifyGraphQLAccessMetadata &
  Readonly<{
    kind: ShopifyGraphQLNamedTypeKind;
    name: string;
    description: string | null;
    specifiedByURL?: string;
    isOneOf?: true;
    fields?: readonly ShopifyGraphQLField[];
    inputFields?: readonly ShopifyGraphQLInputValue[];
    /** Interfaces implemented by an object or another interface. */
    interfaces?: readonly string[];
    enumValues?: readonly ShopifyGraphQLEnumValue[];
    /** Concrete implementations of an interface, or members of a union. */
    possibleTypes?: readonly string[];
  }>;

export type ShopifyGraphQLDirective = Readonly<{
  name: string;
  description: string | null;
  isRepeatable: boolean;
  locations: readonly string[];
  args: readonly ShopifyGraphQLInputValue[];
}>;

export type ShopifyGraphQLRootConnection = Readonly<{
  name: string;
  type: string;
  connectionType: string;
  nodeType: string | null;
}>;

export type ShopifyGraphQLRoot = Readonly<{
  type: string;
  fields: readonly string[];
}>;

export type ShopifyGraphQLQueryRoot = ShopifyGraphQLRoot &
  Readonly<{
    connectionFields: readonly ShopifyGraphQLRootConnection[];
  }>;

export type ShopifyAdminGraphQLSchemaCounts = Readonly<{
  types: number;
  /** Standard `__Schema` metadata types are not part of Shopify's Admin API surface. */
  excludedStandardIntrospectionTypes: number;
  typeKinds: Readonly<Record<ShopifyGraphQLNamedTypeKind, number>>;
  fields: number;
  objectFields: number;
  interfaceFields: number;
  inputFields: number;
  fieldArguments: number;
  directives: number;
  directiveArguments: number;
  enumValues: number;
  queryRootFields: number;
  queryRootConnectionFields: number;
  mutationRootFields: number;
  subscriptionRootFields: number;
  deprecatedFields: number;
  deprecatedInputFields: number;
  deprecatedFieldArguments: number;
  deprecatedEnumValues: number;
  protectedTypes: number;
  protectedFields: number;
  accessRestrictedTypes: number;
  accessRestrictedFields: number;
  privatelyDocumentedTypes: number;
  privatelyDocumentedFields: number;
}>;

export type ShopifyAdminGraphQLSchemaRegistry = Readonly<{
  registryVersion: 1;
  apiVersion: typeof SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION;
  source: Readonly<{
    provider: "Shopify";
    api: "Admin GraphQL API";
    apiVersion: typeof SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION;
    introspectionUrl: string;
    documentationUrl: string;
    proxyDocumentationUrl: string;
    standardIntrospectionTypesIncluded: false;
    schemaSha256: string;
  }>;
  counts: ShopifyAdminGraphQLSchemaCounts;
  schemaDescription: string | null;
  roots: Readonly<{
    query: ShopifyGraphQLQueryRoot;
    mutation: ShopifyGraphQLRoot | null;
    subscription: ShopifyGraphQLRoot | null;
  }>;
  directives: readonly ShopifyGraphQLDirective[];
  types: readonly ShopifyGraphQLType[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRegistryDocument(
  value: unknown,
): asserts value is ShopifyAdminGraphQLSchemaRegistry {
  if (!isRecord(value)) throw new Error("The Shopify schema registry is not a JSON object.");
  if (value.registryVersion !== 1) {
    throw new Error(`Unsupported Shopify schema registry version ${String(value.registryVersion)}.`);
  }
  if (value.apiVersion !== SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION) {
    throw new Error(
      `Shopify schema registry is pinned to ${String(value.apiVersion)}, expected ${SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION}.`,
    );
  }
  if (!isRecord(value.source) || value.source.apiVersion !== value.apiVersion) {
    throw new Error("Shopify schema registry source metadata does not match its API version.");
  }
  if (!Array.isArray(value.types) || value.types.length === 0) {
    throw new Error("Shopify schema registry contains no named types.");
  }
  if (!isRecord(value.counts) || value.counts.types !== value.types.length) {
    throw new Error("Shopify schema registry type count does not match its payload.");
  }
  if (!isRecord(value.roots) || !isRecord(value.roots.query)) {
    throw new Error("Shopify schema registry contains no query root.");
  }
}

const decodedRegistry: unknown = registryJson;
assertRegistryDocument(decodedRegistry);

/**
 * The immutable, version-pinned schema document generated from Shopify's
 * official unauthenticated Admin GraphQL introspection proxy.
 */
export const SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY = decodedRegistry;

/** Returns the committed registry without network access or credentials. */
export function loadShopifyAdminSchemaRegistry(): ShopifyAdminGraphQLSchemaRegistry {
  return SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY;
}

export type ShopifyAdminGraphQLSchemaIndex = Readonly<{
  document: ShopifyAdminGraphQLSchemaRegistry;
  typesByName: ReadonlyMap<string, ShopifyGraphQLType>;
  queryRoot: ShopifyGraphQLType;
  mutationRoot: ShopifyGraphQLType | null;
  subscriptionRoot: ShopifyGraphQLType | null;
}>;

let defaultIndex: ShopifyAdminGraphQLSchemaIndex | undefined;

function indexedRoot(
  typesByName: ReadonlyMap<string, ShopifyGraphQLType>,
  root: ShopifyGraphQLRoot | null,
  role: string,
): ShopifyGraphQLType | null {
  if (!root) return null;
  const type = typesByName.get(root.type);
  if (!type || type.kind !== "OBJECT" || !type.fields) {
    throw new Error(`Shopify ${role} root ${root.type} does not resolve to an object type.`);
  }
  return type;
}

/**
 * Builds the name index used by schema-driven query planners. The default
 * registry index is cached; custom documents remain independently indexable in
 * tests or migrations.
 */
export function indexShopifyAdminSchemaRegistry(
  document: ShopifyAdminGraphQLSchemaRegistry = SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY,
): ShopifyAdminGraphQLSchemaIndex {
  if (document === SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY && defaultIndex) return defaultIndex;
  const typesByName = new Map(document.types.map((type) => [type.name, type] as const));
  if (typesByName.size !== document.types.length) {
    throw new Error("Shopify schema registry contains duplicate named types.");
  }
  const queryRoot = indexedRoot(typesByName, document.roots.query, "query");
  if (!queryRoot) throw new Error("Shopify schema registry has no query root object.");
  const index = {
    document,
    typesByName,
    queryRoot,
    mutationRoot: indexedRoot(typesByName, document.roots.mutation, "mutation"),
    subscriptionRoot: indexedRoot(typesByName, document.roots.subscription, "subscription"),
  } satisfies ShopifyAdminGraphQLSchemaIndex;
  if (document === SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY) defaultIndex = index;
  return index;
}

/** Extracts the single named type from a rendered GraphQL type reference. */
export function shopifyGraphQLNamedType(typeRef: string): string {
  const names = typeRef.match(/[_A-Za-z][_0-9A-Za-z]*/gu) ?? [];
  if (names.length !== 1) throw new Error(`Invalid rendered GraphQL type reference: ${typeRef}.`);
  return names[0]!;
}

/** Resolves a field without permitting an unregistered physical identifier. */
export function shopifyGraphQLField(
  index: ShopifyAdminGraphQLSchemaIndex,
  typeName: string,
  fieldName: string,
): ShopifyGraphQLField | undefined {
  return index.typesByName.get(typeName)?.fields?.find(({ name }) => name === fieldName);
}
