import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const API_VERSION = "2026-07";
const REGISTRY_VERSION = 1;
const INTROSPECTION_URL = `https://shopify.dev/admin-graphql-direct-proxy/${API_VERSION}`;
const DOCUMENTATION_URL = `https://shopify.dev/docs/api/admin-graphql/${API_VERSION}`;
const CODEGEN_DOCUMENTATION_URL =
  "https://shopify.dev/docs/api/shopify-app-remix/v3/guide-graphql-types";
const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(
  projectRoot,
  `connectors/shopify/generated/admin-graphql-${API_VERSION}.json`,
);
const checkOnly = process.argv.includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}. Only --check is supported.`);
}

type TypeKind =
  | "SCALAR"
  | "OBJECT"
  | "INTERFACE"
  | "UNION"
  | "ENUM"
  | "INPUT_OBJECT"
  | "LIST"
  | "NON_NULL";

type IntrospectionTypeRef = Readonly<{
  kind: TypeKind;
  name: string | null;
  ofType: IntrospectionTypeRef | null;
}>;

type AccessMetadata = Readonly<{
  accessRestricted?: boolean;
  accessRestrictedReason?: string | null;
  isProtected?: boolean;
  protectedSubject?: string | null;
  protectedContent?: string | null;
  requiredAccess?: string | null;
  isPrivatelyDocumented?: boolean;
}>;

type IntrospectionInputValue = Readonly<{
  name: string;
  description: string | null;
  type: IntrospectionTypeRef;
  defaultValue: string | null;
  isDeprecated: boolean;
  deprecationReason: string | null;
  gidTypes: readonly string[] | null;
}>;

type IntrospectionField = AccessMetadata &
  Readonly<{
    name: string;
    description: string | null;
    args: readonly IntrospectionInputValue[];
    type: IntrospectionTypeRef;
    isDeprecated: boolean;
    deprecationReason: string | null;
  }>;

type IntrospectionEnumValue = Readonly<{
  name: string;
  description: string | null;
  isDeprecated: boolean;
  deprecationReason: string | null;
  isPrivatelyDocumented?: boolean;
}>;

type IntrospectionType = AccessMetadata &
  Readonly<{
    kind: TypeKind;
    name: string | null;
    description: string | null;
    specifiedByURL: string | null;
    isOneOf: boolean;
    fields: readonly IntrospectionField[] | null;
    inputFields: readonly IntrospectionInputValue[] | null;
    interfaces: readonly Readonly<{ name: string | null }>[] | null;
    enumValues: readonly IntrospectionEnumValue[] | null;
    possibleTypes: readonly Readonly<{ name: string | null }>[] | null;
  }>;

type IntrospectionDirective = Readonly<{
  name: string;
  description: string | null;
  isRepeatable: boolean | null;
  locations: readonly string[];
  args: readonly IntrospectionInputValue[];
}>;

type IntrospectionSchema = Readonly<{
  description: string | null;
  queryType: Readonly<{ name: string }> | null;
  mutationType: Readonly<{ name: string }> | null;
  subscriptionType: Readonly<{ name: string }> | null;
  types: readonly IntrospectionType[];
  directives: readonly IntrospectionDirective[];
}>;

type GraphqlError = Readonly<{
  message?: string;
  path?: readonly (string | number)[];
}>;

type GraphqlResponse = Readonly<{
  data?: Readonly<{ __schema?: IntrospectionSchema | null }> | null;
  errors?: readonly GraphqlError[];
}>;

type RegistryInputValue = Readonly<{
  name: string;
  description: string | null;
  type: string;
  defaultValue: string | null;
  isDeprecated: boolean;
  deprecationReason?: string;
  gidTypes?: readonly string[];
}>;

type RegistryField = AccessMetadata &
  Readonly<{
    name: string;
    description: string | null;
    type: string;
    args: readonly RegistryInputValue[];
    isDeprecated: boolean;
    deprecationReason?: string;
  }>;

type RegistryType = AccessMetadata &
  Readonly<{
    kind: Exclude<TypeKind, "LIST" | "NON_NULL">;
    name: string;
    description: string | null;
    specifiedByURL?: string;
    isOneOf?: true;
    fields?: readonly RegistryField[];
    inputFields?: readonly RegistryInputValue[];
    interfaces?: readonly string[];
    enumValues?: readonly Readonly<{
      name: string;
      description: string | null;
      isDeprecated: boolean;
      deprecationReason?: string;
      isPrivatelyDocumented?: true;
    }>[];
    possibleTypes?: readonly string[];
  }>;

function typeRefSelection(depth: number): string {
  return `kind name${depth > 0 ? ` ofType { ${typeRefSelection(depth - 1)} }` : ""}`;
}

const typeRef = typeRefSelection(12);

const INTROSPECTION_QUERY = `
query AlbertShopifyAdminSchemaRegistry {
  __schema {
    description
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      specifiedByURL
      isOneOf
      accessRestricted
      accessRestrictedReason
      isProtected
      protectedSubject
      requiredAccess
      isPrivatelyDocumented
      fields(includeDeprecated: true) {
        name
        description
        type { ${typeRef} }
        args(includeDeprecated: true) {
          name
          description
          type { ${typeRef} }
          defaultValue
          isDeprecated
          deprecationReason
          gidTypes
        }
        isDeprecated
        deprecationReason
        accessRestricted
        accessRestrictedReason
        isProtected
        protectedSubject
        protectedContent
        requiredAccess
        isPrivatelyDocumented
      }
      inputFields(includeDeprecated: true) {
        name
        description
        type { ${typeRef} }
        defaultValue
        isDeprecated
        deprecationReason
        gidTypes
      }
      interfaces { name }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
        isPrivatelyDocumented
      }
      possibleTypes { name }
    }
    directives {
      name
      description
      isRepeatable
      locations
      args(includeDeprecated: true) {
        name
        description
        type { ${typeRef} }
        defaultValue
        isDeprecated
        deprecationReason
        gidTypes
      }
    }
  }
}`;

function normalizedText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized.length > 0 ? normalized : null;
}

function compareNames(left: Readonly<{ name: string }>, right: Readonly<{ name: string }>): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function sortedNames(values: readonly Readonly<{ name: string | null }>[], context: string): string[] {
  const names = values.map(({ name }) => {
    if (!name) throw new Error(`${context} contains an unnamed type reference.`);
    return name;
  });
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function renderTypeRef(ref: IntrospectionTypeRef, context: string): string {
  if (ref.kind === "NON_NULL") {
    if (!ref.ofType) throw new Error(`${context} has a NON_NULL type with no wrapped type.`);
    return `${renderTypeRef(ref.ofType, context)}!`;
  }
  if (ref.kind === "LIST") {
    if (!ref.ofType) throw new Error(`${context} has a LIST type with no wrapped type.`);
    return `[${renderTypeRef(ref.ofType, context)}]`;
  }
  if (!ref.name) {
    throw new Error(
      `${context} has an unnamed ${ref.kind} type. Increase the introspection type-ref depth if this is a wrapper.`,
    );
  }
  return ref.name;
}

function accessMetadata(value: AccessMetadata): AccessMetadata {
  return {
    ...(value.accessRestricted ? { accessRestricted: true } : {}),
    ...(normalizedText(value.accessRestrictedReason)
      ? { accessRestrictedReason: normalizedText(value.accessRestrictedReason) }
      : {}),
    ...(value.isProtected ? { isProtected: true } : {}),
    ...(normalizedText(value.protectedSubject)
      ? { protectedSubject: normalizedText(value.protectedSubject) }
      : {}),
    ...(normalizedText(value.protectedContent)
      ? { protectedContent: normalizedText(value.protectedContent) }
      : {}),
    ...(normalizedText(value.requiredAccess)
      ? { requiredAccess: normalizedText(value.requiredAccess) }
      : {}),
    ...(value.isPrivatelyDocumented ? { isPrivatelyDocumented: true } : {}),
  };
}

function inputValue(
  value: IntrospectionInputValue,
  context: string,
): RegistryInputValue {
  if (!value.name) throw new Error(`${context} contains an unnamed input value.`);
  return {
    name: value.name,
    description: normalizedText(value.description),
    type: renderTypeRef(value.type, `${context}.${value.name}`),
    defaultValue: normalizedText(value.defaultValue),
    isDeprecated: Boolean(value.isDeprecated),
    ...(normalizedText(value.deprecationReason)
      ? { deprecationReason: normalizedText(value.deprecationReason)! }
      : {}),
    ...(value.gidTypes && value.gidTypes.length > 0
      ? { gidTypes: [...value.gidTypes].sort() }
      : {}),
  };
}

function field(value: IntrospectionField, owner: string): RegistryField {
  if (!value.name) throw new Error(`${owner} contains an unnamed field.`);
  return {
    name: value.name,
    description: normalizedText(value.description),
    type: renderTypeRef(value.type, `${owner}.${value.name}`),
    args: [...(value.args ?? [])]
      .map((argument) => inputValue(argument, `${owner}.${value.name}`))
      .sort(compareNames),
    isDeprecated: Boolean(value.isDeprecated),
    ...(normalizedText(value.deprecationReason)
      ? { deprecationReason: normalizedText(value.deprecationReason)! }
      : {}),
    ...accessMetadata(value),
  };
}

function registryType(value: IntrospectionType): RegistryType | null {
  if (!value.name || value.name.startsWith("__")) return null;
  if (value.kind === "LIST" || value.kind === "NON_NULL") {
    throw new Error(`Schema type ${value.name} unexpectedly has wrapper kind ${value.kind}.`);
  }
  const name = value.name;
  return {
    kind: value.kind,
    name,
    description: normalizedText(value.description),
    ...accessMetadata(value),
    ...(normalizedText(value.specifiedByURL)
      ? { specifiedByURL: normalizedText(value.specifiedByURL)! }
      : {}),
    ...(value.isOneOf ? { isOneOf: true } : {}),
    ...(value.kind === "OBJECT" || value.kind === "INTERFACE"
      ? {
          fields: [...(value.fields ?? [])]
            .map((candidate) => field(candidate, name))
            .sort(compareNames),
          interfaces: sortedNames(value.interfaces ?? [], `${name}.interfaces`),
        }
      : {}),
    ...(value.kind === "INPUT_OBJECT"
      ? {
          inputFields: [...(value.inputFields ?? [])]
            .map((candidate) => inputValue(candidate, name))
            .sort(compareNames),
        }
      : {}),
    ...(value.kind === "ENUM"
      ? {
          enumValues: [...(value.enumValues ?? [])]
            .map((candidate) => ({
              name: candidate.name,
              description: normalizedText(candidate.description),
              isDeprecated: Boolean(candidate.isDeprecated),
              ...(normalizedText(candidate.deprecationReason)
                ? { deprecationReason: normalizedText(candidate.deprecationReason)! }
                : {}),
              ...(candidate.isPrivatelyDocumented ? { isPrivatelyDocumented: true as const } : {}),
            }))
            .sort(compareNames),
        }
      : {}),
    ...(value.kind === "INTERFACE" || value.kind === "UNION"
      ? { possibleTypes: sortedNames(value.possibleTypes ?? [], `${name}.possibleTypes`) }
      : {}),
  };
}

function unwrapNamedType(type: string): string {
  return type.replace(/[\[\]!]/gu, "");
}

function fieldNamedType(candidate: RegistryField): string {
  return unwrapNamedType(candidate.type);
}

function connectionNodeType(
  connection: RegistryType,
  typeByName: ReadonlyMap<string, RegistryType>,
): string | null {
  const nodes = connection.fields?.find(({ name }) => name === "nodes");
  if (nodes) return fieldNamedType(nodes);

  const edges = connection.fields?.find(({ name }) => name === "edges");
  if (!edges) return null;
  const edge = typeByName.get(fieldNamedType(edges));
  const node = edge?.fields?.find(({ name }) => name === "node");
  return node ? fieldNamedType(node) : null;
}

function isConnectionType(candidate: RegistryType | undefined): candidate is RegistryType {
  if (!candidate || candidate.kind !== "OBJECT") return false;
  if (candidate.name.endsWith("Connection")) return true;
  const fields = new Set(candidate.fields?.map(({ name }) => name) ?? []);
  return fields.has("pageInfo") && (fields.has("nodes") || fields.has("edges"));
}

function requiredRootType(
  typeByName: ReadonlyMap<string, RegistryType>,
  name: string | null,
  role: string,
): RegistryType | null {
  if (!name) return null;
  const candidate = typeByName.get(name);
  if (!candidate || candidate.kind !== "OBJECT" || !candidate.fields) {
    throw new Error(`${role} root type ${name} is missing or is not an object.`);
  }
  return candidate;
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

function buildRegistry(schema: IntrospectionSchema) {
  if (!schema.queryType?.name) throw new Error("Shopify introspection returned no query root type.");
  const types = schema.types
    .map(registryType)
    .filter((value): value is RegistryType => value !== null)
    .sort(compareNames);
  const duplicateTypes = types.filter(
    (candidate, index) => index > 0 && types[index - 1]?.name === candidate.name,
  );
  if (duplicateTypes.length > 0) {
    throw new Error(`Shopify introspection returned duplicate types: ${duplicateTypes.map(({ name }) => name).join(", ")}.`);
  }
  const typeByName = new Map(types.map((candidate) => [candidate.name, candidate] as const));
  const query = requiredRootType(typeByName, schema.queryType.name, "query");
  const mutation = requiredRootType(typeByName, schema.mutationType?.name ?? null, "mutation");
  const subscription = requiredRootType(
    typeByName,
    schema.subscriptionType?.name ?? null,
    "subscription",
  );
  if (!query) throw new Error("Shopify introspection returned no query root object.");

  const connectionFields = query.fields!
    .map((candidate) => {
      const connection = typeByName.get(fieldNamedType(candidate));
      if (!isConnectionType(connection)) return null;
      return {
        name: candidate.name,
        type: candidate.type,
        connectionType: connection.name,
        nodeType: connectionNodeType(connection, typeByName),
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null)
    .sort(compareNames);

  const directives = [...schema.directives]
    .map((directive) => ({
      name: directive.name,
      description: normalizedText(directive.description),
      isRepeatable: Boolean(directive.isRepeatable),
      locations: [...directive.locations].sort(),
      args: [...directive.args]
        .map((argument) => inputValue(argument, `@${directive.name}`))
        .sort(compareNames),
    }))
    .sort(compareNames);

  const allFields = types.flatMap((candidate) => candidate.fields ?? []);
  const allInputFields = types.flatMap((candidate) => candidate.inputFields ?? []);
  const allFieldArguments = allFields.flatMap((candidate) => candidate.args);
  const allDirectiveArguments = directives.flatMap((candidate) => candidate.args);
  const allEnumValues = types.flatMap((candidate) => candidate.enumValues ?? []);
  const typeKinds = Object.fromEntries(
    (["SCALAR", "OBJECT", "INTERFACE", "UNION", "ENUM", "INPUT_OBJECT"] as const).map(
      (kind) => [kind, count(types, (candidate) => candidate.kind === kind)],
    ),
  );
  const roots = {
    query: {
      type: query.name,
      fields: query.fields!.map(({ name }) => name),
      connectionFields,
    },
    mutation: mutation
      ? { type: mutation.name, fields: mutation.fields!.map(({ name }) => name) }
      : null,
    subscription: subscription
      ? { type: subscription.name, fields: subscription.fields!.map(({ name }) => name) }
      : null,
  };
  const counts = {
    types: types.length,
    excludedStandardIntrospectionTypes: schema.types.filter(({ name }) =>
      name?.startsWith("__"),
    ).length,
    typeKinds,
    fields: allFields.length,
    objectFields: types
      .filter(({ kind }) => kind === "OBJECT")
      .reduce((total, candidate) => total + (candidate.fields?.length ?? 0), 0),
    interfaceFields: types
      .filter(({ kind }) => kind === "INTERFACE")
      .reduce((total, candidate) => total + (candidate.fields?.length ?? 0), 0),
    inputFields: allInputFields.length,
    fieldArguments: allFieldArguments.length,
    directives: directives.length,
    directiveArguments: allDirectiveArguments.length,
    enumValues: allEnumValues.length,
    queryRootFields: query.fields!.length,
    queryRootConnectionFields: connectionFields.length,
    mutationRootFields: mutation?.fields?.length ?? 0,
    subscriptionRootFields: subscription?.fields?.length ?? 0,
    deprecatedFields: count(allFields, ({ isDeprecated }) => isDeprecated),
    deprecatedInputFields: count(allInputFields, ({ isDeprecated }) => isDeprecated),
    deprecatedFieldArguments: count(allFieldArguments, ({ isDeprecated }) => isDeprecated),
    deprecatedEnumValues: count(allEnumValues, ({ isDeprecated }) => isDeprecated),
    protectedTypes: count(types, ({ isProtected }) => Boolean(isProtected)),
    protectedFields: count(allFields, ({ isProtected }) => Boolean(isProtected)),
    accessRestrictedTypes: count(types, ({ accessRestricted }) => Boolean(accessRestricted)),
    accessRestrictedFields: count(allFields, ({ accessRestricted }) => Boolean(accessRestricted)),
    privatelyDocumentedTypes: count(
      types,
      ({ isPrivatelyDocumented }) => Boolean(isPrivatelyDocumented),
    ),
    privatelyDocumentedFields: count(
      allFields,
      ({ isPrivatelyDocumented }) => Boolean(isPrivatelyDocumented),
    ),
  };
  const schemaContent = {
    schemaDescription: normalizedText(schema.description),
    roots,
    directives,
    types,
  };
  const schemaSha256 = createHash("sha256")
    .update(JSON.stringify(schemaContent), "utf8")
    .digest("hex");

  return {
    registryVersion: REGISTRY_VERSION,
    apiVersion: API_VERSION,
    source: {
      provider: "Shopify",
      api: "Admin GraphQL API",
      apiVersion: API_VERSION,
      introspectionUrl: INTROSPECTION_URL,
      documentationUrl: DOCUMENTATION_URL,
      proxyDocumentationUrl: CODEGEN_DOCUMENTATION_URL,
      standardIntrospectionTypesIncluded: false,
      schemaSha256,
    },
    counts,
    ...schemaContent,
  };
}

function graphqlErrorMessage(errors: readonly GraphqlError[]): string {
  return errors
    .map((error) => {
      const path = error.path?.length ? ` at ${error.path.join(".")}` : "";
      return `${error.message ?? "Unknown GraphQL error"}${path}`;
    })
    .join("; ");
}

function retryDelayMilliseconds(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 10_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 10_000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function fetchSchema(): Promise<IntrospectionSchema> {
  const maximumAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let response: Response | null = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      response = await fetch(INTROSPECTION_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": `Albert-Shopify-Schema-Registry/${REGISTRY_VERSION}`,
        },
        body: JSON.stringify({ query: INTROSPECTION_QUERY }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        const suffix = body.slice(0, 1_000).replace(/\s+/gu, " ").trim();
        throw new Error(
          `Shopify schema proxy returned HTTP ${response.status}${suffix ? `: ${suffix}` : ""}`,
        );
      }
      let decoded: GraphqlResponse | readonly GraphqlError[];
      try {
        decoded = JSON.parse(body) as GraphqlResponse | readonly GraphqlError[];
      } catch (error) {
        throw new Error("Shopify schema proxy returned non-JSON content.", { cause: error });
      }
      if (Array.isArray(decoded)) {
        throw new Error(`Shopify schema introspection failed: ${graphqlErrorMessage(decoded)}`);
      }
      const parsed = decoded as GraphqlResponse;
      if (parsed.errors?.length) {
        throw new Error(`Shopify schema introspection failed: ${graphqlErrorMessage(parsed.errors)}`);
      }
      const schema = parsed.data?.__schema;
      if (!schema || !Array.isArray(schema.types) || !Array.isArray(schema.directives)) {
        const diagnostic = body.slice(0, 1_000).replace(/\s+/gu, " ").trim();
        throw new Error(
          `Shopify schema proxy returned no complete __schema payload${diagnostic ? `: ${diagnostic}` : "."}`,
        );
      }
      return schema;
    } catch (error) {
      lastError = error;
      const retryable =
        response === null || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maximumAttempts) break;
      await wait(retryDelayMilliseconds(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(
    `Unable to fetch Shopify Admin GraphQL ${API_VERSION} schema after ${maximumAttempts} attempts.`,
    { cause: lastError },
  );
}

function writeAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o644 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

const schema = await fetchSchema();
const registry = buildRegistry(schema);
const output = `${JSON.stringify(registry)}\n`;

if (checkOnly) {
  if (!existsSync(outputPath)) {
    throw new Error(
      `Shopify schema registry is missing at ${outputPath}. Run npm run shopify:schema:generate.`,
    );
  }
  const current = readFileSync(outputPath, "utf8");
  if (current !== output) {
    let currentHash = "unreadable";
    try {
      currentHash = String(
        (JSON.parse(current) as { source?: { schemaSha256?: string } }).source?.schemaSha256 ??
          "missing",
      );
    } catch {
      // The byte comparison is authoritative; this hash is only diagnostic.
    }
    throw new Error(
      `Shopify Admin GraphQL ${API_VERSION} registry is stale (committed ${currentHash}, official ${registry.source.schemaSha256}). Run npm run shopify:schema:generate.`,
    );
  }
  process.stdout.write(
    `Shopify Admin GraphQL ${API_VERSION} registry is fresh: ${registry.counts.types} types, ${registry.counts.fields} fields, ${registry.counts.queryRootConnectionFields} QueryRoot connections (${registry.source.schemaSha256}).\n`,
  );
} else {
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeAtomically(outputPath, output);
  process.stdout.write(
    `Generated Shopify Admin GraphQL ${API_VERSION} registry: ${registry.counts.types} types, ${registry.counts.fields} fields, ${registry.counts.queryRootConnectionFields} QueryRoot connections at ${outputPath} (${registry.source.schemaSha256}).\n`,
  );
}
