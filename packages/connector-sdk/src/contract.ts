import type { ConnectorId } from "./index.js";

export type FieldDisposition = "canonical" | "governed_extension" | "unsupported";
export type StagingFieldType =
  | "text"
  | "numeric"
  | "boolean"
  | "date"
  | "timestamptz"
  | "jsonb";
export type PiiClass =
  | "none"
  | "business_contact"
  | "customer_contact"
  | "employee_contact"
  | "payroll_sensitive"
  | "free_text_untrusted";

export type FieldCoverage = Readonly<{
  stream: string;
  field: string;
  disposition: FieldDisposition;
  stagingType: StagingFieldType;
  target?: string;
  reason?: string;
  pii: PiiClass;
}>;

export type StreamContract = Readonly<{
  id: string;
  resource: string;
  endpoint: string;
  recordIdField: string;
  modifiedField?: string;
  /** Source-declared Resource API joins needed to materialize reviewed evidence. */
  queryJoins?: readonly string[];
  pagination:
    | "vendor_cursor"
    | "page"
    | "offset"
    | "resource_start"
    | "resource_id_keyset"
    | "none";
  canonicalTargets: readonly string[];
}>;

export type RateLimitContract = Readonly<{
  algorithm: string;
  concurrency?: number;
  budgets?: Readonly<Record<string, number | string>>;
  responseHeaders: readonly string[];
}>;

export type ConnectorManifest = Readonly<{
  id: ConnectorId;
  displayName: string;
  packVersion: string;
  apiVersion: string;
  releasedAt: string;
  documentation: readonly string[];
  oauth: Readonly<{
    scopes: readonly string[];
    readOnlyScopeExceptions: readonly string[];
    refreshTokenRotation: boolean;
    remoteRevocation: "supported" | "not_documented";
  }>;
  streams: readonly StreamContract[];
  rateLimit: RateLimitContract;
  capabilities: Readonly<Record<string, "full" | "partial" | "unavailable" | "unknown">>;
  identityRules: readonly string[];
  topology: readonly string[];
  fieldCoverage: readonly FieldCoverage[];
  qualityAssertions: readonly string[];
  limitations: readonly string[];
  unknownFieldPolicy: "quarantine_schema_drift";
}>;

export function assertFixtureFieldCoverage(
  manifest: ConnectorManifest,
  stream: string,
  records: readonly Readonly<Record<string, unknown>>[],
): void {
  const covered = new Set(
    manifest.fieldCoverage
      .filter((entry) => entry.stream === stream)
      .map((entry) => entry.field),
  );
  for (const record of records) {
    for (const field of Object.keys(record)) {
      if (!covered.has(field)) {
        throw new Error(
          `${manifest.id}.${stream} field ${field} has no coverage disposition.`,
        );
      }
    }
  }
}
