export type MomenceHttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

export type MomenceLeafDirection = "request" | "response";

export type MomenceLeafLocation =
  | "cookie"
  | "header"
  | "path"
  | "query"
  | "requestBody"
  | "responseBody";

export type MomenceLeafReadability = "request-only" | "response-readable";

export type MomenceJsonPrimitive = string | number | boolean | null;

type MomenceEntitySchemaBase = Readonly<{
  /** Exact pointer in the pinned Momence OpenAPI artifact. */
  sourcePointer: string;
  nullable: boolean;
}>;

export type MomenceEntityPrimitiveSchema = MomenceEntitySchemaBase & Readonly<{
  kind: "boolean" | "integer" | "number" | "string" | "unknown";
  format?: string;
  enumValues?: readonly MomenceJsonPrimitive[];
}>;

export type MomenceEntityArraySchema = MomenceEntitySchemaBase & Readonly<{
  kind: "array";
  items: MomenceEntitySchema;
}>;

export type MomenceEntityObjectSchema = MomenceEntitySchemaBase & Readonly<{
  kind: "object";
  properties: Readonly<Record<string, MomenceEntitySchema>>;
  required: readonly string[];
  /** False means the official response schema is closed to undocumented keys. */
  additionalProperties: false | true | MomenceEntitySchema;
}>;

export type MomenceEntityUnionSchema = MomenceEntitySchemaBase & Readonly<{
  kind: "union";
  mode: "anyOf" | "oneOf";
  variants: readonly MomenceEntitySchema[];
}>;

/** Dereferenced response-entity contract emitted from the pinned official schema. */
export type MomenceEntitySchema =
  | MomenceEntityArraySchema
  | MomenceEntityObjectSchema
  | MomenceEntityPrimitiveSchema
  | MomenceEntityUnionSchema;

export type MomenceEntityValidationContract = Readonly<{
  streamId: string;
  operationKey: string;
  responseStatus: string;
  contentType: string;
  rootSchema: string;
  entitySourcePointer: string;
  schema: MomenceEntitySchema;
}>;

export type MomenceOperationContent = Readonly<{
  contentType: string;
  required: boolean;
  schemaRoots: readonly string[];
  leafFieldIds: readonly string[];
}>;

export type MomenceOperationResponse = Readonly<{
  statusCode: string;
  contents: readonly MomenceOperationContent[];
}>;

export type MomenceOpenApiOperation = Readonly<{
  key: string;
  operationId: string;
  method: MomenceHttpMethod;
  path: string;
  summary: string;
  tags: readonly string[];
  requestContents: readonly MomenceOperationContent[];
  responses: readonly MomenceOperationResponse[];
  leafFieldIds: readonly string[];
  requestLeafCount: number;
  responseLeafCount: number;
}>;

export type MomenceOpenApiLeafField = Readonly<{
  id: string;
  operationKey: string;
  operationId: string;
  method: MomenceHttpMethod;
  path: string;
  direction: MomenceLeafDirection;
  location: MomenceLeafLocation;
  statusCode?: string;
  contentType?: string;
  rootSchema: string;
  schema: string;
  /** Exact OpenAPI pointer at which the emitted scalar shape is declared. */
  schemaPath: string;
  fieldPath: string;
  type: string;
  /** Alias with an ingestion-facing name for consumers of MOMENCE_API_FIELDS. */
  jsonType: string;
  format?: string;
  enumValues?: readonly MomenceJsonPrimitive[];
  required: boolean;
  requiredInSchema: boolean;
  nullable: boolean;
  conditional: boolean;
  readable: boolean;
  readability: MomenceLeafReadability;
  /** True only for response fields reachable through a declared Momence read stream. */
  storeReadReachable: boolean;
  openApiReadOnly: boolean;
  openApiWriteOnly: boolean;
  description?: string;
  sourcePointer: string;
  ancestrySourcePointers: readonly string[];
}>;

export type MomenceOpenApiCoverage = Readonly<{
  generatorVersion: number;
  source: Readonly<{
    url: string;
    sha256: string;
    byteLength: number;
    openapiVersion: string;
    apiTitle: string;
    apiVersion: string;
    serverUrls: readonly string[];
  }>;
  counts: Readonly<{
    paths: number;
    operations: number;
    componentSchemas: number;
    reachableSchemas: number;
    componentProperties: number;
    operationLeafFields: number;
    requestLeafFields: number;
    responseLeafFields: number;
    readableLeafFields: number;
    parameterLeafFields: number;
    requestBodyLeafFields: number;
    responseBodyLeafFields: number;
    uniqueSourceLeafDefinitions: number;
    entityValidationContracts: number;
  }>;
  digests: Readonly<{
    operationKeySha256: string;
    leafInventorySha256: string;
    reachablePropertySha256: string;
    entityValidationContractSha256: string;
  }>;
  reachableSchemas: readonly string[];
  unreachableSchemas: readonly string[];
  reachablePropertyPointers: readonly string[];
  uncoveredPropertyPointers: readonly string[];
  entityValidationContracts: readonly MomenceEntityValidationContract[];
  operations: readonly MomenceOpenApiOperation[];
  fields: readonly MomenceOpenApiLeafField[];
}>;
