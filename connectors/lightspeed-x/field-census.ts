import endpointCensusJson from "./endpoint-census.generated.json" with { type: "json" };
import fieldCensusJson from "./field-census.generated.json" with { type: "json" };
import coverageJson from "./field-coverage.generated.json" with { type: "json" };

import type { FieldCoverage } from "../../packages/connector-sdk/src/contract.js";

export type LightspeedXEndpointCensusRow = Readonly<{
  operationId: string;
  method: string;
  path: string;
  requiredScopes: readonly string[];
  pagination: string | null;
  responseSchemas: readonly string[];
  officialSourceUrl: string;
  disposition:
    | "scheduled_read_stream"
    | "read_endpoint_on_demand_or_redundant"
    | "read_function_on_demand_not_scheduled"
    | "read_requires_write_capable_scope_not_requested"
    | "management_scope_not_requested"
    | "vendor_write_not_implemented";
  scheduledStreamId: string | null;
}>;

export type LightspeedXOfficialField = Readonly<{
  root_schema: string;
  defining_schema: string;
  field_path: string;
  json_pointer: string;
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

export const LIGHTSPEED_X_ENDPOINT_CENSUS = endpointCensusJson as readonly LightspeedXEndpointCensusRow[];
export const LIGHTSPEED_X_OFFICIAL_FIELD_CENSUS = fieldCensusJson as unknown as Readonly<{
  apiVersion: "2026-07";
  sourceArtifact: string;
  sourceSha256: string;
  fieldCount: 5202;
  fields: readonly LightspeedXOfficialField[];
}>;
export const LIGHTSPEED_X_FIELD_COVERAGE = coverageJson as unknown as readonly FieldCoverage[];

export function assertLightspeedXOfficialCoverage(): void {
  if (LIGHTSPEED_X_OFFICIAL_FIELD_CENSUS.fields.length !== 5_202) {
    throw new Error("Lightspeed X-Series official field census is incomplete.");
  }
  const censusKeys = new Set(LIGHTSPEED_X_OFFICIAL_FIELD_CENSUS.fields.map((field) =>
    `${field.root_schema}:${field.field_path}`));
  const scheduled = new Set<string>();
  const unavailable = new Set<string>();
  for (const entry of LIGHTSPEED_X_FIELD_COVERAGE) {
    if (entry.stream === "lx_official_contract_unavailable") unavailable.add(entry.field);
    const officialFieldKeys = (entry as FieldCoverage & Readonly<{ officialFieldKeys?: readonly string[] }>)
      .officialFieldKeys ?? [];
    if (officialFieldKeys.length > 0 &&
      (entry.storageField !== "field_index" || entry.storageType !== "jsonb" || !entry.queryPath?.startsWith("$."))) {
      throw new Error(`Lightspeed X-Series scheduled field ${entry.stream}.${entry.field} is not queryable through field_index.`);
    }
    for (const key of officialFieldKeys) {
      if (!censusKeys.has(key)) throw new Error(`Unknown Lightspeed X-Series official field key ${key}.`);
      scheduled.add(key);
    }
  }
  const queryableApi = new Set(
    LIGHTSPEED_X_FIELD_COVERAGE
      .filter((entry) => entry.stream !== "lx_official_contract_unavailable")
      .map((entry) => entry.field),
  );
  if (!queryableApi.has("field_index")) {
    throw new Error("Lightspeed X-Series runtime field_index escape hatch is missing.");
  }
  const missing = LIGHTSPEED_X_OFFICIAL_FIELD_CENSUS.fields.filter((field) => {
    const key = `${field.root_schema}:${field.field_path}`;
    return !unavailable.has(key) && !scheduled.has(key);
  });
  if (missing.length > 0) {
    throw new Error(`Lightspeed X-Series coverage is missing ${missing.length} official fields.`);
  }
  const overlap = [...scheduled].filter((key) => unavailable.has(key));
  if (overlap.length > 0) {
    throw new Error(`Lightspeed X-Series coverage contradicts itself for ${overlap.length} official fields.`);
  }
  if (scheduled.size + unavailable.size !== censusKeys.size) {
    throw new Error("Lightspeed X-Series coverage contains duplicate or non-census dispositions.");
  }
}
