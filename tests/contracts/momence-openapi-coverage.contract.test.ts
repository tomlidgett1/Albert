import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MOMENCE_API_FIELDS,
  MOMENCE_OPENAPI_COVERAGE,
} from "../../connectors/momence/openapi-coverage.generated.js";
import type { MomenceOpenApiLeafField } from "../../connectors/momence/openapi-coverage-types.js";
import { MOMENCE_OPENAPI_SPEC_LOCK } from "../../connectors/momence/spec-lock.js";
import { MOMENCE_READ_STREAMS } from "../../connectors/momence/streams.js";

const coverage = MOMENCE_OPENAPI_COVERAGE;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digestLines(values: readonly string[]): string {
  return sha256([...values].sort(compareText).join("\n"));
}

function leafInventoryLine(field: MomenceOpenApiLeafField): string {
  return [
    field.id,
    field.method,
    field.path,
    field.schema,
    field.fieldPath,
    field.type,
    field.required ? "required" : "optional",
    field.nullable ? "nullable" : "non-null",
    field.readability,
    field.storeReadReachable ? "store-readable" : "not-store-readable",
    field.sourcePointer,
  ].join("\u0000");
}

function assertSortedUnique(values: readonly string[], label: string): void {
  assert.deepEqual(values, [...values].sort(compareText), `${label} must be sorted`);
  assert.equal(new Set(values).size, values.length, `${label} must be unique`);
}

test("Momence coverage is pinned to the exact official OpenAPI v2 artifact", () => {
  assert.equal(coverage.source.url, MOMENCE_OPENAPI_SPEC_LOCK.sourceUrl);
  assert.equal(coverage.source.sha256, MOMENCE_OPENAPI_SPEC_LOCK.sourceSha256);
  assert.equal(coverage.source.byteLength, MOMENCE_OPENAPI_SPEC_LOCK.sourceByteLength);
  assert.equal(coverage.source.openapiVersion, MOMENCE_OPENAPI_SPEC_LOCK.openapiVersion);
  assert.equal(coverage.source.apiTitle, MOMENCE_OPENAPI_SPEC_LOCK.apiTitle);
  assert.equal(coverage.source.apiVersion, MOMENCE_OPENAPI_SPEC_LOCK.apiVersion);
  assert.deepEqual(coverage.source.serverUrls, [MOMENCE_OPENAPI_SPEC_LOCK.productionServerUrl]);

  const expected = MOMENCE_OPENAPI_SPEC_LOCK.expected;
  assert.equal(coverage.counts.paths, expected.paths);
  assert.equal(coverage.counts.operations, expected.operations);
  assert.equal(coverage.counts.componentSchemas, expected.componentSchemas);
  assert.equal(coverage.counts.reachableSchemas, expected.reachableSchemas);
  assert.equal(coverage.counts.componentProperties, expected.componentProperties);
  assert.equal(coverage.counts.operationLeafFields, expected.operationLeafFields);
  assert.equal(coverage.counts.requestLeafFields, expected.requestLeafFields);
  assert.equal(coverage.counts.responseLeafFields, expected.responseLeafFields);
  assert.equal(coverage.counts.readableLeafFields, expected.readableLeafFields);
  assert.equal(coverage.counts.entityValidationContracts, expected.entityValidationContracts);
  assert.equal(coverage.digests.operationKeySha256, expected.operationKeySha256);
  assert.equal(coverage.digests.leafInventorySha256, expected.leafInventorySha256);
  assert.equal(coverage.digests.reachablePropertySha256, expected.reachablePropertySha256);
  assert.equal(
    coverage.digests.entityValidationContractSha256,
    expected.entityValidationContractSha256,
  );
});

test("all 74 operations are explicit, stable and retain their field memberships", () => {
  const operationKeys = coverage.operations.map(({ key }) => key);
  assertSortedUnique(operationKeys, "Momence operation keys");
  assert.equal(digestLines(operationKeys), coverage.digests.operationKeySha256);
  assert.equal(new Set(coverage.operations.map(({ operationId }) => operationId)).size, coverage.operations.length);

  const methods = Object.fromEntries(
    ["DELETE", "GET", "POST", "PUT"].map((method) => [
      method,
      coverage.operations.filter((operation) => operation.method === method).length,
    ]),
  );
  assert.deepEqual(methods, { DELETE: 13, GET: 28, POST: 18, PUT: 15 });
  assert.equal(new Set(coverage.operations.map(({ path }) => path)).size, coverage.counts.paths);

  const fieldsById = new Map(MOMENCE_API_FIELDS.map((field) => [field.id, field]));
  const referencedIds = new Set<string>();
  for (const operation of coverage.operations) {
    assert.equal(operation.key, `${operation.method} ${operation.path}`);
    assertSortedUnique(operation.leafFieldIds, `${operation.key} leaf ids`);
    const fields = operation.leafFieldIds.map((id) => {
      const field = fieldsById.get(id);
      assert.ok(field, `${operation.key} references missing leaf ${id}`);
      referencedIds.add(id);
      assert.equal(field.operationKey, operation.key);
      assert.equal(field.operationId, operation.operationId);
      assert.equal(field.method, operation.method);
      assert.equal(field.path, operation.path);
      return field;
    });
    assert.equal(operation.requestLeafCount, fields.filter(({ direction }) => direction === "request").length);
    assert.equal(operation.responseLeafCount, fields.filter(({ direction }) => direction === "response").length);

    for (const content of operation.requestContents) {
      for (const id of content.leafFieldIds) {
        const field = fieldsById.get(id);
        assert.ok(field);
        assert.equal(field.direction, "request");
        assert.equal(field.location, "requestBody");
        assert.equal(field.contentType, content.contentType);
      }
    }
    for (const response of operation.responses) {
      for (const content of response.contents) {
        for (const id of content.leafFieldIds) {
          const field = fieldsById.get(id);
          assert.ok(field);
          assert.equal(field.direction, "response");
          assert.equal(field.location, "responseBody");
          assert.equal(field.statusCode, response.statusCode);
          assert.equal(field.contentType, content.contentType);
        }
      }
    }
  }
  assert.equal(referencedIds.size, coverage.fields.length, "every generated field must belong to an operation");
});

test("every request and response leaf is retained with queryability metadata", () => {
  assert.equal(MOMENCE_API_FIELDS, coverage.fields);
  assert.equal(MOMENCE_API_FIELDS.length, coverage.counts.operationLeafFields);
  assertSortedUnique(MOMENCE_API_FIELDS.map(({ id }) => id).sort(compareText), "Momence field ids");
  assert.equal(digestLines(MOMENCE_API_FIELDS.map(leafInventoryLine)), coverage.digests.leafInventorySha256);

  const storeReadOperationKeys = new Set(
    MOMENCE_READ_STREAMS.map(({ endpoint }) => `GET ${endpoint}`),
  );
  for (const field of MOMENCE_API_FIELDS) {
    assert.match(field.id, /^[a-f0-9]{24}$/u);
    assert.ok(field.fieldPath.startsWith("$"), `${field.id} has a non-rooted field path`);
    assert.ok(field.schema.length > 0);
    assert.equal(field.schemaPath, field.sourcePointer);
    assert.equal(field.jsonType, field.type);
    assert.equal(field.readable, field.direction === "response" && !field.openApiWriteOnly);
    assert.equal(field.readability, field.readable ? "response-readable" : "request-only");
    assert.equal(
      field.storeReadReachable,
      field.readable && storeReadOperationKeys.has(field.operationKey),
      `${field.id} has incorrect store-read reachability`,
    );
    if (field.required) {
      assert.equal(field.requiredInSchema, true);
    }
    if (field.direction === "request") assert.equal(field.storeReadReachable, false);
  }

  assert.equal(MOMENCE_API_FIELDS.filter(({ direction }) => direction === "request").length, coverage.counts.requestLeafFields);
  assert.equal(MOMENCE_API_FIELDS.filter(({ direction }) => direction === "response").length, coverage.counts.responseLeafFields);
  assert.equal(MOMENCE_API_FIELDS.filter(({ readable }) => readable).length, coverage.counts.readableLeafFields);
  assert.ok(MOMENCE_API_FIELDS.some(({ storeReadReachable }) => storeReadReachable));
});

test("all 200 reachable schemas and all 1,465 component properties have operation coverage", () => {
  assertSortedUnique(coverage.reachableSchemas, "reachable Momence schemas");
  assertSortedUnique(coverage.reachablePropertyPointers, "reachable Momence property pointers");
  assert.deepEqual(coverage.unreachableSchemas, []);
  assert.deepEqual(coverage.uncoveredPropertyPointers, []);
  assert.equal(coverage.reachableSchemas.length, coverage.counts.reachableSchemas);
  assert.equal(coverage.reachablePropertyPointers.length, coverage.counts.componentProperties);
  assert.equal(
    digestLines(coverage.reachablePropertyPointers),
    coverage.digests.reachablePropertySha256,
  );

  const encounteredPointers = new Set(
    MOMENCE_API_FIELDS.flatMap((field) => [field.sourcePointer, ...field.ancestrySourcePointers]),
  );
  for (const pointer of coverage.reachablePropertyPointers) {
    assert.ok(encounteredPointers.has(pointer), `reachable property was silently dropped: ${pointer}`);
  }
});
