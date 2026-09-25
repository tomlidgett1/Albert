import assert from "node:assert/strict";
import test from "node:test";

import {
  LIGHTSPEED_X_ENDPOINT_CENSUS,
  LIGHTSPEED_X_FIELD_COVERAGE,
  LIGHTSPEED_X_OFFICIAL_FIELD_CENSUS,
  assertLightspeedXOfficialCoverage,
} from "../../connectors/lightspeed-x/field-census.js";
import {
  LIGHTSPEED_X_DEFAULT_SCOPES,
  lightspeedXManifest,
} from "../../connectors/lightspeed-x/manifest.js";
import { LIGHTSPEED_X_CONTRACT_LOCK } from "../../connectors/lightspeed-x/spec-lock.js";
import { LIGHTSPEED_X_STREAMS } from "../../connectors/lightspeed-x/streams.js";
import {
  assertConnectorManifestReconciliationPolicy,
  buildStagingContracts,
  renderTypedStagingMigration,
} from "../../packages/connector-sdk/src/index.js";

test("official 2026-07 lock and all 5,202 expanded fields are accounted for", () => {
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.apiVersion, "2026-07");
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.mergedOpenApi.operationCount, 196);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.mergedOpenApi.schemaCount, 308);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.mergedOpenApi.directFieldCount, 1_633);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.mergedOpenApi.expandedFieldCount, 5_202);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.officialBulkOpenApi.sha256,
    "123b2630178c376990dd7219f92e068e5f77ac9cd991a80e0fafa97ad8613dd7");
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.officialBulkOpenApi.pathCount, 130);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.officialBulkOpenApi.operationCount, 196);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.officialBulkOpenApi.schemaCount, 356);
  assert.equal(LIGHTSPEED_X_CONTRACT_LOCK.officialBulkOpenApi.scheduledResponseFieldCount, 1_323);
  assert.equal(LIGHTSPEED_X_OFFICIAL_FIELD_CENSUS.fields.length, 5_202);
  assert.equal(LIGHTSPEED_X_FIELD_COVERAGE.length >= 5_202, true);
  assert.doesNotThrow(assertLightspeedXOfficialCoverage);
  const inlineResponseCoverage = new Map(LIGHTSPEED_X_FIELD_COVERAGE.map((entry) =>
    [`${entry.stream}:${entry.field}`, entry]));
  for (const key of [
    "lx_product_categories:category_path[].id",
    "lx_services:service.line_items[].tax_components[].total_tax",
    "lx_service_items:item_details.serial_number",
    "lx_partner_subscriptions:partner_subscription_info[].components[].unit_price",
  ]) {
    const entry = inlineResponseCoverage.get(key);
    assert.ok(entry, `${key} is missing its official inline-response disposition`);
    assert.equal(entry.storageField, "field_index");
    assert.match(entry.queryPath ?? "", /^\$\./u);
  }
  assert.ok(Object.values(LIGHTSPEED_X_CONTRACT_LOCK.documentation).every((url) =>
    new URL(url).hostname === "x-series-api.lightspeedhq.com"));
});

test("the complete scheduled read surface is contract-driven and least privilege", () => {
  assert.equal(LIGHTSPEED_X_STREAMS.length, 52);
  assert.equal(new Set(LIGHTSPEED_X_STREAMS.map((stream) => stream.id)).size, 52);
  const scheduled = LIGHTSPEED_X_ENDPOINT_CENSUS.filter((entry) => entry.disposition === "scheduled_read_stream");
  assert.equal(scheduled.length, 52);
  assert.deepEqual(
    scheduled.map((entry) => entry.scheduledStreamId).sort(),
    LIGHTSPEED_X_STREAMS.map((stream) => stream.id).sort(),
  );
  assert.deepEqual(
    LIGHTSPEED_X_STREAMS.filter((stream) => stream.method === "POST").map((stream) => stream.endpoint).sort(),
    ["/inventory", "/inventory_levels"],
  );
  assert.ok(LIGHTSPEED_X_STREAMS.every((stream) =>
    stream.method === "GET" || ["/inventory", "/inventory_levels"].includes(stream.endpoint)));
  assert.ok(LIGHTSPEED_X_STREAMS.every((stream) =>
    stream.requiredScopes.every((scope) => LIGHTSPEED_X_DEFAULT_SCOPES.includes(
      scope as (typeof LIGHTSPEED_X_DEFAULT_SCOPES)[number],
    ))));
  assert.equal(LIGHTSPEED_X_DEFAULT_SCOPES.some((scope) => scope.endsWith(":write")), false);
  assert.equal(LIGHTSPEED_X_DEFAULT_SCOPES.includes("webhooks" as never), false);
  assert.equal(lightspeedXManifest.ingestion.initialStart, "manual");
  assert.equal(lightspeedXManifest.oauth.refreshTokenRotation, true);
  assert.equal(lightspeedXManifest.oauth.remoteRevocation, "not_documented");
  assert.doesNotThrow(() => assertConnectorManifestReconciliationPolicy(lightspeedXManifest));
});

test("every stream has immutable JSON plus a typed field-index staging escape hatch", () => {
  const contracts = buildStagingContracts([lightspeedXManifest]);
  assert.equal(contracts.length, 52);
  for (const contract of contracts) {
    assert.equal(contract.schema, "source_lightspeed_x");
    assert.ok(contract.fields.some((field) => field.sourceField === "payload_json" && field.type === "jsonb"));
    assert.ok(contract.fields.some((field) => field.sourceField === "field_index" && field.type === "jsonb"));
  }
  for (const stream of LIGHTSPEED_X_STREAMS) {
    const coverage = LIGHTSPEED_X_FIELD_COVERAGE.filter((entry) => entry.stream === stream.id);
    assert.ok(coverage.some((entry) => entry.field === "payload_json"));
    assert.ok(coverage.some((entry) => entry.field === "field_index"));
  }
  const stagingSql = renderTypedStagingMigration([lightspeedXManifest]);
  assert.match(
    stagingSql,
    /numericValue'[\s\S]*\(\?:\[eE\]\[\+-\]\?\[0-9\]\+\)\?\$/u,
    "the source-field view must cast valid JSON exponent notation to numeric",
  );
});

test("rate policy encodes the official register formula and durable five-minute budget", () => {
  const reservation = lightspeedXManifest.rateLimit.reservations[0];
  assert.ok(reservation);
  assert.equal(lightspeedXManifest.rateLimit.concurrency, 2);
  assert.deepEqual(lightspeedXManifest.rateLimit.responseHeaders, [
    "X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After",
  ]);
  assert.equal(reservation.interval.kind, "window_budget");
  if (reservation.interval.kind !== "window_budget") return;
  assert.equal(reservation.interval.windowMilliseconds, 300_000);
  assert.equal(reservation.interval.defaultLimit, 350);
  assert.equal(reservation.interval.allowedLimits[0], 350);
  assert.equal(reservation.interval.allowedLimits[49], 15_050);
  assert.equal(reservation.interval.allowedLimits[99], 30_050);
  assert.equal(reservation.interval.headroomRequests, 10);
});
