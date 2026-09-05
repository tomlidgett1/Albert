export type SquareCensusShape =
  | Readonly<{ kind: "scalar"; type: string }>
  | Readonly<{ kind: "unknown"; type: string }>
  | Readonly<{ kind: "reference"; target: string }>
  | Readonly<{ kind: "array"; item: SquareCensusShape }>
  | Readonly<{ kind: "map"; value: SquareCensusShape }>
  | Readonly<{ kind: "object"; fields: readonly SquareCensusField[] }>
  | Readonly<{ kind: "union"; options: readonly SquareCensusShape[] }>
  | Readonly<{ kind: "intersection"; parts: readonly SquareCensusShape[] }>;

export type SquareCensusField = Readonly<{
  /** Exact snake_case wire key from the SDK serializer's Raw declaration. */
  name: string;
  optional: boolean;
  shape: SquareCensusShape;
}>;

export type SquareCensusModel = Readonly<{
  name: string;
  source: string;
  shape: SquareCensusShape;
}>;

export type SquareSdkRequestContract = Readonly<{
  streamId: string;
  method: "GET" | "POST";
  /** Exact endpoint template recorded by the pinned SDK client. */
  endpoint: string;
  /** Client source, relative to the root of the immutable SDK package. */
  sdkClientSource: string;
  sdkOperation: string;
  /** All first-class query keys published by the SDK operation. */
  sdkQueryKeys: readonly string[];
  /** Null for GET operations; POST bodies are checked by this SDK serializer. */
  sdkRequestSerializer: string | null;
  probe: Readonly<{
    method: "GET" | "POST";
    path: string;
    query: Readonly<Record<string, unknown>>;
    body: Readonly<Record<string, unknown>> | null;
  }>;
  validation: Readonly<{
    exactOperationMatch: true;
    queryKeysAccepted: true;
    bodyWireRoundTrip: true | null;
    unknownBodyKeyStripped: true | null;
  }>;
}>;

export type SquareSdkFieldCensus = Readonly<{
  apiVersion: string;
  sdkPackage: string;
  sdkVersion: string;
  sdkTarballSha256: string;
  generatorVersion: number;
  rawDeclarationCount: number;
  pinnedHeaderOccurrenceCount: number;
  rootEntities: readonly string[];
  models: Readonly<Record<string, SquareCensusModel>>;
  /** Generation fails unless every read stream passes the official SDK wire contract. */
  requestContracts: readonly SquareSdkRequestContract[];
}>;
