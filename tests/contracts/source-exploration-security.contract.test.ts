import assert from "node:assert/strict";
import test from "node:test";

import { loadRegistryFile } from "../../packages/semantic-registry/src/index.js";
import {
  DefaultSemanticToolExecutor,
  PostgresSourceCatalogueProvider,
  compileSourceQuery,
  type SourceField,
  type TenantSemanticContext,
} from "../../services/semantic-query/src/index.js";
import { sourceAuthorityForField } from "../../services/sync-workers/src/canonical-pipeline.js";

const tenantId = "01J00000000000000000000001";
const trusted = {
  tenantId,
  role: "owner" as const,
  conversationId: "01J00000000000000000000002",
  turnId: "01J00000000000000000000003",
};

const stockField = field({ sourceField: "reorder_point", authorityConcept: "stock" });
const salesField = field({ sourceField: "discount_reason", authorityConcept: "operational_sales" });
const financeField = field({
  connectorId: "xero",
  connectionId: "connection-xero",
  sourceSchema: "source_xero",
  sourceTable: "bank_transactions",
  sourceField: "reference",
  authorityConcept: "cash_settlement",
});
const financeTimestampField = field({
  connectorId: "xero",
  connectionId: "connection-xero",
  sourceSchema: "source_xero",
  sourceTable: "bank_transactions",
  sourceField: "updated_at",
  fieldType: "timestamp",
  authorityConcept: "cash_settlement",
});

test("source authority is server-derived, single-domain and deterministically ordered", () => {
  const compiled = compileSourceQuery(query([stockField.sourceField]), tenantId, "owner", [stockField]);
  assert.equal(compiled.authorityConcept, "stock");
  assert.match(compiled.sql, /ORDER BY s\."reorder_point" ASC NULLS LAST\nLIMIT \$3$/u);

  assert.throws(
    () => compileSourceQuery({ ...query([stockField.sourceField]), authorityConcept: "operational_sales" }, tenantId, "owner", [stockField]),
    /unrecognized key|authorityConcept/iu,
  );
  assert.throws(
    () => compileSourceQuery(query([stockField.sourceField, salesField.sourceField]), tenantId, "owner", [stockField, salesField]),
    /different authority concepts/iu,
  );
  assert.throws(
    () => compileSourceQuery(query(["orphan"]), tenantId, "owner", [field({ sourceField: "orphan", authorityConcept: undefined })]),
    /governed authority concept/iu,
  );

  const grouped = compileSourceQuery({
    ...query(["category"]),
    aggregates: [{ op: "sum" as const, field: "amount", as: "total_amount" }],
    groupBy: ["category"],
  }, tenantId, "owner", [
    field({ sourceField: "category", authorityConcept: "operational_sales" }),
    field({ sourceField: "amount", fieldType: "decimal", authorityConcept: "operational_sales" }),
  ]);
  assert.match(grouped.sql, /GROUP BY s\."category"\nORDER BY s\."category" ASC NULLS LAST\nLIMIT/u);
});

test("source extensions enforce Topic-equivalent role permissions and PII gates", () => {
  assert.throws(() => compileSourceQuery(query([stockField.sourceField]), tenantId, "bookkeeper", [stockField]), /cannot explore stock/iu);
  assert.throws(() => compileSourceQuery(query([financeField.sourceField]), tenantId, "manager", [financeField]), /cannot explore cash_settlement/iu);
  assert.doesNotThrow(() => compileSourceQuery(query([salesField.sourceField]), tenantId, "bookkeeper", [salesField]));
  assert.throws(() => compileSourceQuery(query(["staff_note"]), tenantId, "owner", [field({
    sourceField: "staff_note",
    authorityConcept: "operational_sales",
    piiClass: "sensitive_personal",
  })]), /PII classification/iu);
});

test("source time provenance is resolved from one governed filter field, never from freshness watermarks", () => {
  const compiled = compileSourceQuery({
    ...query([financeField.sourceField]),
    filters: [
      { field: "updated_at",op: "gte" as const,values: ["2026-07-01T00:00:00+10:00"] },
      { field: "updated_at",op: "lt" as const,values: ["2026-08-01T00:00:00+10:00"] },
    ],
  },tenantId,"owner",[financeField,financeTimestampField]);
  assert.deepEqual(compiled.resolvedTime,{
    field: "updated_at",
    label: "Updated At · >= 2026-06-30T14:00:00.000Z · < 2026-07-31T14:00:00.000Z",
    start: "2026-06-30T14:00:00.000Z",
    end: "2026-07-31T14:00:00.000Z",
  });
  assert.throws(() => compileSourceQuery({
    ...query([financeField.sourceField]),
    filters: [{ field: "updated_at",op: "in" as const,values: ["2026-07-01T00:00:00.000Z"] }],
  },tenantId,"owner",[financeField,financeTimestampField]),/contiguous provenance range/iu);
});

test("catalogue list, search, resolve and values all fail closed for forbidden domains", async () => {
  const calls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const provider = new PostgresSourceCatalogueProvider({
    async queryAsSemanticRole(request) {
      calls.push({ sql: request.sql, parameters: request.parameters });
      return { rows: [databaseRow(financeField)], durationMs: 1 };
    },
  });
  const manager = { ...trusted, role: "manager" as const };
  assert.deepEqual(await provider.listFields(manager, financeField.connectionId, financeField.sourceTable), []);
  assert.deepEqual(await provider.searchFields(manager, "reference", 10), []);
  assert.deepEqual(await provider.resolveRankedFields(manager, [{ connectorId: "xero", sourceTable: "bank_transactions", sourceField: "reference" }], 10), []);
  await assert.rejects(() => provider.listFieldValues(manager, "source:connection-xero:bank_transactions:reference", undefined, 10), /cannot explore cash_settlement/iu);
  assert.ok(calls.every((call) => /authority_concept=ANY\(\$[34]::text\[\]\)/u.test(call.sql)));
  assert.ok(calls.every((call) => call.parameters.some((value) => Array.isArray(value) && !value.includes("cash_settlement"))));
});

test("a wrong or omitted model authority cannot suppress the non-authoritative warning", async () => {
  const registry = loadRegistryFile("packages/semantic-registry/registry/registry.yaml");
  const tenant: TenantSemanticContext = {
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters: {},
    capabilities: new Set(),
    overlayVersion: "overlay-v1",
    identityGraphVersion: 0,
    identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
    defaults: {},
    dossier: {},
    packVersions: { xero: "1.0.0" },
    sourceWatermarks: { "connection-xero": "2026-08-03T00:00:00.000Z" },
    sourceDetails: [{ connectorId: "xero", connectionId: "connection-xero", label: "Xero", dataThrough: "2026-08-03T00:00:00.000Z" }],
    authorityByConcept: { cash_settlement: "authoritative-xero-connection" },
  };
  const service = new DefaultSemanticToolExecutor({
    registry,
    contextProvider: { async load() { return tenant; } },
    database: { async queryAsSemanticRole() { return { rows: [{ reference: "deposit" }], durationMs: 1 }; } },
    cache: { async get() { return undefined; }, async set() {} },
    sourceCatalogue: { async listFields() { return [financeField,financeTimestampField]; } },
    dataHealth: { async getForTopic() { return { status: "passed", checks: [] }; } },
    audit: { async append() {}, async promoteSourceField() { return "promotion-01"; } },
    clock: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  const response = await service.execute("run_source_query", {
    connectionId: "connection-xero",
    sourceTable: "bank_transactions",
    fields: ["reference"],
    aggregates: [],
    groupBy: [],
    filters: [
      { field: "updated_at",op: "gte",values: ["2026-07-01T00:00:00.000Z"] },
      { field: "updated_at",op: "lt",values: ["2026-08-01T00:00:00.000Z"] },
    ],
    limit: 10,
  }, trusted);
  assert.deepEqual(response.validation.warnings, [
    "This source is not authoritative for cash_settlement; authoritative-xero-connection is authoritative.",
  ]);
  assert.deepEqual(response.provenance.sourceWatermarks,{
    "connection-xero": "2026-08-03T00:00:00.000Z",
  });
  assert.deepEqual(response.provenance.timeRange,{
    label: "Updated At · >= 2026-07-01T00:00:00.000Z · < 2026-08-01T00:00:00.000Z",
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
    timezone: "Australia/Melbourne",
  });
});

test("source exploration fails closed when the selected connection watermark is absent", async () => {
  let databaseCalls = 0;
  const registry = loadRegistryFile("packages/semantic-registry/registry/registry.yaml");
  const service = new DefaultSemanticToolExecutor({
    registry,
    contextProvider: { async load() {
      return {
        timezone: "Australia/Melbourne",tradingDayCutoff: "00:00",fiscalYearStartMonth: 7,
        fiscalYearStartDay: 1,weekStartsOn: 1,tenantParameters: {},capabilities: new Set<string>(),
        overlayVersion: "overlay-v1",identityGraphVersion: 0,
        identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",defaults: {},dossier: {},
        packVersions: { xero: "1.0.0" },
        sourceWatermarks: { "some-other-connection": "2026-08-03T00:00:00.000Z" },
        sourceDetails: [],authorityByConcept: { cash_settlement: "connection-xero" },
      };
    } },
    database: { async queryAsSemanticRole() { databaseCalls += 1;return { rows: [],durationMs: 1 }; } },
    cache: { async get() { return undefined; },async set() {} },
    sourceCatalogue: { async listFields() { return [financeField]; } },
    dataHealth: { async getForTopic() { return { status: "passed",checks: [] }; } },
    audit: { async append() {},async promoteSourceField() { return "promotion-01"; } },
  });
  await assert.rejects(() => service.execute("run_source_query",{
    connectionId: "connection-xero",sourceTable: "bank_transactions",fields: ["reference"],
    aggregates: [],groupBy: [],filters: [],limit: 10,
  },trusted),/selected source has no valid watermark/iu);
  assert.equal(databaseCalls,0);
});

test("connector stream authority mapping is explicit and rejects drift", () => {
  assert.equal(sourceAuthorityForField("xero", "bank_transactions", "source_xero.bank_transactions.reference"), "cash_settlement");
  assert.equal(sourceAuthorityForField("xero", "journals", "source_xero.journals.source_type"), "statutory_finance");
  assert.equal(sourceAuthorityForField("deputy", "rosters", "source_deputy.rosters.open"), "planned_shifts");
  assert.equal(sourceAuthorityForField("deputy", "timesheets", "source_deputy.timesheets.exported"), "worked_hours");
  assert.equal(sourceAuthorityForField("lightspeed-r", "customers", "source_lightspeed.customers.credit_limit"), "customer_master");
  assert.equal(sourceAuthorityForField("lightspeed-r", "item_shops", "source_lightspeed.item_shops.reorder_point"), "stock");
  assert.equal(sourceAuthorityForField("lightspeed-r", "vendors", "source_lightspeed.vendors.account_number"), "stock");
  assert.throws(() => sourceAuthorityForField("xero", "unknown", "source_xero.unknown.value"), /source_authority_unmapped/u);
  assert.throws(() => sourceAuthorityForField("xero", "journals", "source_deputy.journals.value"), /target_mismatch/u);
});

function query(fields: readonly string[]) {
  return { connectionId: fields.includes("reference") ? "connection-xero" : "connection-lightspeed", sourceTable: fields.includes("reference") ? "bank_transactions" : "items", fields, aggregates: [], groupBy: [], filters: [], limit: 10 };
}

function field(overrides: Partial<SourceField>): SourceField {
  return {
    connectionId: "connection-lightspeed",
    connectorId: "lightspeed-r",
    sourceSchema: "source_lightspeed",
    sourceTable: "items",
    sourceField: "extension",
    fieldType: "text",
    piiClass: "none",
    authorityConcept: "product_master",
    definition: "Governed connector extension.",
    packVersion: "1.1.0",
    ...overrides,
  };
}

function databaseRow(value: SourceField): Readonly<Record<string, unknown>> {
  return {
    connection_id: value.connectionId,
    connector_id: value.connectorId,
    source_schema: value.sourceSchema,
    source_table: value.sourceTable,
    source_field: value.sourceField,
    field_type: value.fieldType,
    pii_class: value.piiClass,
    authority_concept: value.authorityConcept,
    documented_definition: value.definition,
    pack_version: value.packVersion,
  };
}
