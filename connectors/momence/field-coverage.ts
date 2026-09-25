import type {
  FieldCoverage,
  PiiClass,
  StagingFieldType,
} from "../../packages/connector-sdk/src/index.js";
import { MOMENCE_OPENAPI_COVERAGE } from "./openapi-coverage.generated.js";
import { MOMENCE_READ_STREAMS, type MomenceReadStream } from "./streams.js";
import type { MomenceOpenApiLeafField } from "./openapi-coverage-types.js";

const COMMON_FIELDS = Object.freeze([
  { field: "recordId", stagingType: "text", pii: "none", disposition: "canonical" },
  { field: "parentId", stagingType: "text", pii: "none", disposition: "governed_extension" },
  { field: "endpoint", stagingType: "text", pii: "none", disposition: "governed_extension" },
  {
    field: "payloadJson", stagingType: "jsonb", pii: "free_text_untrusted",
    disposition: "governed_extension", queryable: false,
  },
  {
    field: "fieldIndex", stagingType: "jsonb", pii: "free_text_untrusted",
    disposition: "governed_extension", queryable: true,
  },
  { field: "name", stagingType: "text", pii: "customer_contact", disposition: "governed_extension" },
  { field: "status", stagingType: "text", pii: "none", disposition: "governed_extension" },
  { field: "occurredAt", stagingType: "timestamptz", pii: "none", disposition: "governed_extension" },
  { field: "memberId", stagingType: "text", pii: "customer_contact", disposition: "governed_extension" },
  { field: "sessionId", stagingType: "text", pii: "none", disposition: "governed_extension" },
  { field: "currency", stagingType: "text", pii: "none", disposition: "governed_extension" },
  { field: "amount", stagingType: "numeric", pii: "none", disposition: "governed_extension" },
  { field: "quantity", stagingType: "numeric", pii: "none", disposition: "governed_extension" },
  { field: "isCancelled", stagingType: "boolean", pii: "none", disposition: "governed_extension" },
] as const satisfies readonly Partial<FieldCoverage>[]);

/** Every public-API leaf receives one explicit analytical disposition. */
export type MomenceApiFieldDisposition = Readonly<{
  fieldId: string;
  operationKey: string;
  method: string;
  path: string;
  fieldPath: string;
  disposition: "ingested_governed" | "protocol_metadata" | "request_only" | "read_boundary";
  stream: string | null;
  reason: string;
}>;

const streamByEndpoint = new Map(MOMENCE_READ_STREAMS.map((stream) => [stream.endpoint, stream]));
const equivalentReadStream = new Map<string, MomenceReadStream>([
  // The host member-detail response is the same HostMemberDto already returned
  // by the complete paginated member population. Answer those operation fields
  // from momence_members instead of spending one request per member to ingest
  // byte-for-byte duplicate semantics.
  [
    "/api/v2/host/members/{memberId}",
    MOMENCE_READ_STREAMS.find((stream) => stream.id === "momence_members")!,
  ],
]);

function successResponse(field: MomenceOpenApiLeafField): boolean {
  return field.method === "GET" && field.direction === "response" && /^2\d\d$/u.test(field.statusCode ?? "");
}

function entityPath(
  stream: MomenceReadStream,
  fieldPath: string,
  sourceEndpoint = stream.endpoint,
): string | null {
  if (sourceEndpoint === "/api/v2/host/members/{memberId}") {
    return fieldPath.startsWith("$response.") ? `$${fieldPath.slice("$response".length)}` : null;
  }
  if (stream.kind === "singleton" || (stream.kind === "fanout" && stream.childPagination === "singleton")) {
    return fieldPath.startsWith("$response.") ? `$${fieldPath.slice("$response".length)}` : null;
  }
  return fieldPath.startsWith("$response.payload[].")
    ? `$${fieldPath.slice("$response.payload[]".length)}`
    : null;
}

function leafType(field: MomenceOpenApiLeafField): StagingFieldType {
  if (field.type === "boolean") return "boolean";
  if (["integer", "number"].includes(field.type)) return "numeric";
  if (field.format === "date") return "date";
  if (
    field.format === "date-time" ||
    /(?:At|Date|Seen|startsAt|endsAt)(?:\[\])?$/u.test(field.fieldPath)
  ) return "timestamptz";
  if (["object", "array"].includes(field.type)) return "jsonb";
  return "text";
}

function pii(field: MomenceOpenApiLeafField): PiiClass {
  const value = `${field.schema}.${field.fieldPath}.${field.description ?? ""}`;
  if (/teacher/iu.test(value) && /(?:name|email|phone|picture)/iu.test(value)) return "employee_contact";
  if (/(?:note|description|contractAgreement|content|signature|password)/iu.test(value)) {
    return "free_text_untrusted";
  }
  if (
    /(?:member|customer|attendee|payingMember|targetMember|address)/iu.test(value) &&
    /(?:firstName|lastName|email|phone|address|city|country|zip|picture|cardLast4|name)/iu.test(value)
  ) return "customer_contact";
  return "none";
}

function boundaryReason(field: MomenceOpenApiLeafField): MomenceApiFieldDisposition["reason"] {
  if (field.direction === "request") {
    return "API input, not an observable store attribute; Albert contains no Momence write method.";
  }
  if (field.fieldPath.startsWith("$response.pagination.")) {
    return "Traversal control metadata is retained as sync-run evidence, not repeated as a store entity field.";
  }
  if (field.path.startsWith("/api/v2/member")) {
    return "Member-personal response belongs to the logged-in person, not the connected host analytics boundary.";
  }
  if (field.path.includes("/reports")) {
    return "Report runs cannot be enumerated and creation requires a hostId that public API v2 does not disclose.";
  }
  if (!["GET"].includes(field.method)) {
    return "Response is reachable only by a vendor mutation that Albert's read-only connector never performs.";
  }
  return "The API exposes no safe store-wide enumeration path for this response.";
}

export const MOMENCE_API_FIELD_DISPOSITIONS: readonly MomenceApiFieldDisposition[] = Object.freeze(
  MOMENCE_OPENAPI_COVERAGE.fields.map((field) => {
    const stream = streamByEndpoint.get(field.path) ?? equivalentReadStream.get(field.path);
    const queryPath = stream && successResponse(field)
      ? entityPath(stream, field.fieldPath, field.path)
      : null;
    if (stream && queryPath) {
      return Object.freeze({
        fieldId: field.id,
        operationKey: field.operationKey,
        method: field.method,
        path: field.path,
        fieldPath: field.fieldPath,
        disposition: "ingested_governed" as const,
        stream: stream.id,
        reason: "Exact entity scalar is retained in the typed Momence field index.",
      });
    }
    const disposition = field.direction === "request"
      ? "request_only" as const
      : field.fieldPath.startsWith("$response.pagination.")
        ? "protocol_metadata" as const
        : "read_boundary" as const;
    return Object.freeze({
      fieldId: field.id,
      operationKey: field.operationKey,
      method: field.method,
      path: field.path,
      fieldPath: field.fieldPath,
      disposition,
      stream: null,
      reason: boundaryReason(field),
    });
  }),
);

const documentedCoverage = MOMENCE_READ_STREAMS.flatMap((stream) => {
  const seen = new Set<string>();
  return MOMENCE_OPENAPI_COVERAGE.fields.flatMap((field): FieldCoverage[] => {
    if (
      !successResponse(field) ||
      (field.path !== stream.endpoint && equivalentReadStream.get(field.path)?.id !== stream.id)
    ) return [];
    const queryPath = entityPath(stream, field.fieldPath, field.path);
    if (!queryPath || seen.has(queryPath)) return [];
    seen.add(queryPath);
    return [{
      stream: stream.id,
      field: queryPath,
      disposition: "governed_extension",
      stagingType: leafType(field),
      storageField: "fieldIndex",
      storageType: "jsonb",
      queryPath,
      queryable: true,
      target: `source_momence.${stream.id}.field_index`,
      pii: pii(field),
    }];
  });
});

const physicalCoverage = MOMENCE_READ_STREAMS.flatMap((stream) => COMMON_FIELDS.map((field): FieldCoverage => ({
  stream: stream.id,
  field: field.field,
  disposition: field.disposition,
  stagingType: field.stagingType,
  pii: field.pii,
  ...("queryable" in field ? { queryable: field.queryable } : {}),
  target: `source_momence.${stream.id}.${field.field}`,
})));

export const MOMENCE_FIELD_COVERAGE: readonly FieldCoverage[] = Object.freeze([
  ...physicalCoverage,
  ...documentedCoverage,
]);
