import assert from "node:assert/strict";
import test from "node:test";

import {
  MOMENCE_API_FIELD_DISPOSITIONS,
  MOMENCE_FIELD_COVERAGE,
} from "../../connectors/momence/field-coverage";
import { MOMENCE_API_FIELDS } from "../../connectors/momence/openapi-coverage.generated";
import { MOMENCE_READ_STREAMS } from "../../connectors/momence/streams";
import type { MomenceOpenApiLeafField } from "../../connectors/momence/openapi-coverage-types";

test("every official Momence API field has exactly one explicit analytical disposition", () => {
  assert.equal(MOMENCE_API_FIELDS.length, 2_225, "the pinned official OpenAPI field inventory changed");
  const dispositionsByField = groupBy(MOMENCE_API_FIELD_DISPOSITIONS, (item) => item.fieldId);

  assert.equal(dispositionsByField.size, MOMENCE_API_FIELDS.length);
  for (const field of MOMENCE_API_FIELDS) {
    const dispositions = dispositionsByField.get(field.id) ?? [];
    assert.equal(dispositions.length, 1, `${field.id} must have exactly one disposition`);
    assert.ok(dispositions[0]?.reason.trim(), `${field.id} must explain its analytical treatment`);
  }
});

test("every store-readable Momence response field is queryable or has an explicit governed boundary", () => {
  const dispositionsByField = new Map(MOMENCE_API_FIELD_DISPOSITIONS.map((item) => [item.fieldId, item]));

  for (const field of MOMENCE_API_FIELDS) {
    if (!field.storeReadReachable || field.direction !== "response") continue;
    const disposition = dispositionsByField.get(field.id);
    assert.ok(disposition, `${field.id} must have a disposition`);

    if (disposition.disposition !== "ingested_governed") {
      assert.equal(
        disposition.disposition,
        "protocol_metadata",
        `${field.id} is safely store-readable and may only be excluded when it is traversal metadata`,
      );
      assert.match(
        field.fieldPath,
        /^\$response\.pagination\./u,
        `${field.id} must not hide a store entity field behind a protocol disposition`,
      );
      assert.ok(disposition.reason.trim(), `${field.id} governed boundary needs a reason`);
      continue;
    }

    assert.ok(disposition.stream, `${field.id} must name its ingesting stream`);
    const queryPath = entityQueryPath(field, disposition.stream);
    assert.ok(queryPath, `${field.id} has an ingested disposition but no entity query path`);
    const coverage = MOMENCE_FIELD_COVERAGE.find((candidate) =>
      candidate.stream === disposition.stream && candidate.queryPath === queryPath,
    );
    assert.ok(coverage, `${field.id} is absent from Momence field coverage at ${disposition.stream}.${queryPath}`);
    assert.equal(coverage.queryable, true, `${field.id} must be queryable through the field index`);
    assert.equal(coverage.storageField, "fieldIndex", `${field.id} must retain its long-form field index`);
  }
});

test("Momence field coverage has no duplicate stream/path query contract", () => {
  const queryable = MOMENCE_FIELD_COVERAGE.filter((field) => field.queryable && field.queryPath);
  const keys = queryable.map((field) => `${field.stream}:${field.queryPath}`);
  assert.equal(new Set(keys).size, keys.length, "a semantic query path must resolve one documented leaf only");
});

test("host member-detail fields reuse the exhaustive member list instead of N+1 duplicate reads", () => {
  const detailFields = MOMENCE_API_FIELDS.filter((field) =>
    field.method === "GET" &&
    field.path === "/api/v2/host/members/{memberId}" &&
    field.direction === "response" &&
    field.statusCode === "200"
  );
  assert.ok(detailFields.length > 0);
  const dispositionById = new Map(
    MOMENCE_API_FIELD_DISPOSITIONS.map((disposition) => [disposition.fieldId, disposition]),
  );
  for (const field of detailFields) {
    const disposition = dispositionById.get(field.id);
    assert.equal(disposition?.disposition, "ingested_governed", field.id);
    assert.equal(disposition?.stream, "momence_members", field.id);
  }
});

function entityQueryPath(field: MomenceOpenApiLeafField, streamId: string): string | null {
  const stream = MOMENCE_READ_STREAMS.find((candidate) => candidate.id === streamId);
  assert.ok(stream, `declared Momence stream ${streamId} is missing`);
  if (stream.kind === "singleton" || (stream.kind === "fanout" && stream.childPagination === "singleton")) {
    return field.fieldPath.startsWith("$response.")
      ? `$${field.fieldPath.slice("$response".length)}`
      : null;
  }
  return field.fieldPath.startsWith("$response.payload[].")
    ? `$${field.fieldPath.slice("$response.payload[]".length)}`
    : null;
}

function groupBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const bucket = grouped.get(key(value)) ?? [];
    bucket.push(value);
    grouped.set(key(value), bucket);
  }
  return grouped;
}
