import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildRegistry,
  loadRegistryFile,
  parseRegistryDocument,
  type SemanticRegistry,
} from "../../packages/semantic-registry/src/index.js";
import {
  DefaultSemanticToolExecutor,
  MemorySemanticResultCache,
  type SemanticAuditRecord,
  type SemanticServiceDependencies,
  type TenantSemanticContext,
} from "../../services/semantic-query/src/index.js";

const tenantId = "01J00000000000000000000001";
const now = "2026-08-03T00:00:00.000Z";
const registryPath = resolve("packages/semantic-registry/registry/registry.yaml");
const registry = loadRegistryFile(registryPath);
const semanticCheckIds = [
  "no_fanout",
  "grain_compatible_ratios",
  "snapshot_not_summed",
  "authority_respected",
  "golden_fixture_match",
] as const;
const trusted = {
  tenantId,
  role: "owner" as const,
  conversationId: "01J00000000000000000000002",
  turnId: "01J00000000000000000000003",
};

test("all five semantic invariants are evidence-derived, audited and identical across cache paths", async () => {
  let databaseCalls = 0;
  const audits: SemanticAuditRecord[] = [];
  const service = serviceFor(registry, {
    audits,
    async query() {
      databaseCalls += 1;
      return { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 2 };
    },
  });
  const input = salesQuery("commerce.net_sales_ex_gst");

  const miss = await service.execute("run_semantic_query", input, trusted);
  const hit = await service.execute("run_semantic_query", input, trusted);

  assert.equal(databaseCalls, 1);
  assert.equal(miss.state, "verified");
  assert.equal(hit.state, "verified");
  assert.equal(miss.performance.cacheHit, false);
  assert.equal(hit.performance.cacheHit, true);
  assert.deepEqual(semanticChecks(hit.validation), semanticChecks(miss.validation));
  assert.deepEqual(semanticChecks(audits[0]!.validation), semanticChecks(miss.validation));
  assert.deepEqual(semanticChecks(audits[1]!.validation), semanticChecks(hit.validation));
  assert.equal(audits[0]!.cacheHit, false);
  assert.equal(audits[1]!.cacheHit, true);
  assert.doesNotMatch(JSON.stringify(miss.validation), /\bselect\b|compiledSql|\bsql\b/iu);

  const fanout = check(miss.validation, "no_fanout");
  assert.equal(fanout.planKind, "single_fact");
  assert.equal(fanout.factCount, 1);
  const publication = check(miss.validation, "golden_fixture_match");
  assert.equal(publication.evidenceKind, "active_content_addressed_publication");
  assert.equal(publication.publicationRegistryVersion, registry.version);
});

test("freshness, provenance and bundle identity include only contributing authoritative connections", async () => {
  const lightspeed = "connection-lightspeed";
  const xero = "connection-xero";
  const deputy = "connection-deputy";
  const tenantWithIrrelevantSources = (xeroWatermark: string, xeroPackVersion: string): Partial<TenantSemanticContext> => ({
    packVersions: { "lightspeed-r": "1.0.0",xero: xeroPackVersion,deputy: "1.0.0" },
    sourceWatermarks: { [lightspeed]: now,[xero]: xeroWatermark,[deputy]: "2020-01-01T00:00:00.000Z" },
    sourceDetails: [
      { connectorId: "lightspeed-r",connectionId: lightspeed,label: "Lightspeed",dataThrough: now },
      { connectorId: "xero",connectionId: xero,label: "Xero",dataThrough: xeroWatermark },
      { connectorId: "deputy",connectionId: deputy,label: "Deputy",dataThrough: "2020-01-01T00:00:00.000Z" },
    ],
  });
  const execute = async (tenant: Partial<TenantSemanticContext>) => serviceFor(registry, {
    tenant,
    async query() { return { rows: [{ net_sales_ex_gst: "210.0000" }],durationMs: 1 }; },
  }).execute("run_semantic_query",salesQuery("commerce.net_sales_ex_gst"),trusted);

  const first = await execute(tenantWithIrrelevantSources("2020-01-01T00:00:00.000Z","1.0.0"));
  const changedIrrelevantSource = await execute(tenantWithIrrelevantSources("2019-01-01T00:00:00.000Z","99.0.0"));

  assert.equal(first.state,"verified");
  assert.deepEqual(first.validation.warnings,[]);
  assert.deepEqual(first.provenance.sourceWatermarks,{ [lightspeed]: now });
  assert.deepEqual(first.provenance.sourceDetails,[{
    connectorId: "lightspeed-r",connectionId: lightspeed,label: "Lightspeed",dataThrough: now,
  }]);
  assert.equal(first.resultId,changedIrrelevantSource.resultId,"irrelevant source changes must not invalidate the semantic bundle");
});

test("semantic results carry compiler-owned global ordering proof across the limit boundary", async () => {
  let compiledSql = "";
  const service = serviceFor(registry, {
    async query(request) {
      compiledSql = request.sql;
      return { rows: [{ location: "Carlton",net_sales_ex_gst: "210.0000" }],durationMs: 1 };
    },
  });
  const response = await service.execute("run_semantic_query",{
    ...salesQuery("commerce.net_sales_ex_gst"),
    dimensions: ["location"],
    sort: [{ metric: "commerce.net_sales_ex_gst",dir: "desc" as const }],
    limit: 1,
  },trusted);

  assert.match(compiledSql,/ORDER BY "net_sales_ex_gst" DESC\nLIMIT \$\d+$/u);
  assert.deepEqual(response.data?.resultWindow,{
    requestedLimit: 1,
    orderedBeforeLimit: true,
    orderBy: [{ columnKey: "net_sales_ex_gst",direction: "desc" }],
  });
});

test("missing or detached authority evidence fails closed and stays closed on a cache hit", async () => {
  let databaseCalls = 0;
  const audits: SemanticAuditRecord[] = [];
  const service = serviceFor(registry, {
    audits,
    tenant: { authorityByConcept: {}, sourceDetails: [] },
    async query() {
      databaseCalls += 1;
      return { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 1 };
    },
  });

  const miss = await service.execute("run_semantic_query", salesQuery("commerce.net_sales_ex_gst"), trusted);
  const hit = await service.execute("run_semantic_query", salesQuery("commerce.net_sales_ex_gst"), trusted);

  assert.equal(databaseCalls, 1);
  assert.equal(miss.state, "unavailable");
  assert.equal(hit.state, "unavailable");
  assert.equal(miss.data, undefined);
  assert.equal(hit.data, undefined);
  assert.equal(check(miss.validation, "authority_respected").status, "blocked");
  assert.equal(check(hit.validation, "authority_respected").status, "blocked");
  assert.equal(check(audits[0]!.validation, "authority_respected").status, "blocked");
  assert.equal(check(audits[1]!.validation, "authority_respected").status, "blocked");
});

test("authority and provenance include recursively referenced metric dependencies", async () => {
  const service = serviceFor(registry, {
    tenant: { authorityByConcept: { worked_hours: "connection-deputy" } },
    async query() { return { rows: [{ roster_adherence: "95.0000" }],durationMs: 1 }; },
  });
  const response = await service.execute("run_semantic_query",{
    topic: "workforce_labour",
    metrics: ["workforce.roster_adherence"],
    dimensions: [],filters: [],time: absoluteTime(),sort: [],limit: 20,parameters: {},
  },trusted);

  assert.equal(response.state,"unavailable");
  const authority = check(response.validation,"authority_respected");
  assert.deepEqual(authority.concepts,[
    { concept: "planned_shifts",status: "blocked",reasonCode: "authority_selection_missing" },
    {
      concept: "worked_hours",connectionId: "connection-deputy",connectorId: "deputy",status: "passed",
    },
  ]);
});

test("an absent or mismatched exact publication proof blocks golden fixture validation", async () => {
  for (const publication of [
    undefined,
    { registryVersion: "0.0.0", registryHash: "e".repeat(64), activePublicationMatches: true },
    { registryVersion: registry.version, registryHash: "e".repeat(64), activePublicationMatches: false },
  ] as const) {
    let databaseCalls = 0;
    const service = serviceFor(registry, {
      publication,
      async query() {
        databaseCalls += 1;
        return { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 1 };
      },
    });
    const miss = await service.execute("run_semantic_query", salesQuery("commerce.net_sales_ex_gst"), trusted);
    const hit = await service.execute("run_semantic_query", salesQuery("commerce.net_sales_ex_gst"), trusted);
    assert.equal(databaseCalls, 1);
    assert.equal(miss.state, "unavailable");
    assert.equal(hit.state, "unavailable");
    assert.equal(miss.data, undefined);
    assert.equal(hit.data, undefined);
    assert.equal(check(miss.validation, "golden_fixture_match").status, "blocked");
    assert.deepEqual(
      check(hit.validation, "golden_fixture_match"),
      check(miss.validation, "golden_fixture_match"),
    );
  }
});

test("ratio grain drift is detected independently after an otherwise successful compile", async () => {
  const document = parseRegistryDocument(readFileSync(registryPath, "utf8"));
  const incompatible = buildRegistry({
    ...document,
    metrics: document.metrics.map((metric) => metric.id === "commerce.transactions"
      ? { ...metric, grain: "one_order_header" }
      : metric),
  });
  const service = serviceFor(incompatible, {
    async query() { return { rows: [{ avg_order_value: "105.0000" }], durationMs: 1 }; },
  });

  const response = await service.execute("run_semantic_query", salesQuery("commerce.avg_order_value"), trusted);
  assert.equal(response.state, "unavailable");
  assert.deepEqual(check(response.validation, "grain_compatible_ratios").incompatibleMetrics, [
    "commerce.avg_order_value",
  ]);
});

test("snapshot and aggregate-then-align evidence records the executed operations without SQL", async () => {
  const inventory = serviceFor(registry, {
    async query() { return { rows: [{ stock_on_hand_units: "12.0000" }], durationMs: 1 }; },
  });
  const snapshot = await inventory.execute("run_semantic_query", {
    topic: "inventory_health",
    metrics: ["inventory.stock_on_hand_units"],
    dimensions: [],
    filters: [],
    time: { field: "snapshot_date", range: { type: "last_n_days", days: 1 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  }, trusted);
  const snapshotCheck = check(snapshot.validation, "snapshot_not_summed");
  assert.equal(snapshotCheck.status, "passed");
  assert.deepEqual(snapshotCheck.accesses, [{
    metricId: "inventory.stock_on_hand_units",
    factId: "inventory_health_day",
    field: "quantity_on_hand",
    operation: "last_value",
  }]);
  assert.doesNotMatch(JSON.stringify(snapshotCheck), /\bselect\b|\bsql\b/iu);

  const composite = serviceFor(registry, {
    async query() {
      return {
        rows: [{ location: "Carlton", net_sales_ex_gst: "210.0000", worked_hours: "7.0000", sales_per_labour_hour: "30.0000" }],
        durationMs: 2,
      };
    },
  });
  const aligned = await composite.execute("run_semantic_query", {
    kind: "composite",
    topic: "workforce_sales",
    metrics: ["composites.sales_per_labour_hour"],
    queries: [
      { topic: "sales_performance", metrics: ["commerce.net_sales_ex_gst"], dimensions: ["location"], filters: [], time: absoluteTime(), parameters: {} },
      { topic: "workforce_labour", metrics: ["workforce.worked_hours"], dimensions: ["location"], filters: [], time: absoluteTime(), parameters: {} },
    ],
    alignOn: ["location"],
    sort: [],
    limit: 20,
    parameters: {},
  }, trusted);
  assert.equal(aligned.state, "verified");
  assert.equal(check(aligned.validation, "no_fanout").planKind, "aggregate_then_align");
  assert.deepEqual(check(aligned.validation, "grain_compatible_ratios").alignOn, ["location"]);
  assert.deepEqual(Object.keys(aligned.provenance.sourceWatermarks).sort(),[
    "connection-deputy","connection-lightspeed",
  ]);
  assert.deepEqual(aligned.provenance.sourceDetails.map((source) => source.connectorId).sort(),[
    "deputy","lightspeed-r",
  ]);
});

function serviceFor(
  semanticRegistry: SemanticRegistry,
  options: Readonly<{
    query: SemanticServiceDependencies["database"]["queryAsSemanticRole"];
    audits?: SemanticAuditRecord[];
    tenant?: Partial<TenantSemanticContext>;
    publication?: Readonly<{
      registryVersion: string;
      registryHash: string;
      activePublicationMatches: boolean;
    }>;
  }>,
): DefaultSemanticToolExecutor {
  const lightspeed = "connection-lightspeed";
  const xero = "connection-xero";
  const deputy = "connection-deputy";
  const watermarks = {
    [lightspeed]: now,
    [xero]: now,
    [deputy]: now,
  };
  const baseTenant: TenantSemanticContext = {
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters: { active_customer_days: 90, lapsed_customer_days: 180, stock_velocity_days: 30 },
    capabilities: new Set([...semanticRegistry.metrics.values()].flatMap((metric) => metric.requiredCapabilities)),
    overlayVersion: "fixture-overlay",
    identityGraphVersion: 0,
    identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
    defaults: {},
    dossier: {},
    packVersions: { "lightspeed-r": "1.0.0", xero: "1.0.0", deputy: "1.0.0" },
    sourceWatermarks: watermarks,
    sourceDetails: [
      { connectorId: "lightspeed-r", connectionId: lightspeed, label: "Lightspeed", dataThrough: now },
      { connectorId: "xero", connectionId: xero, label: "Xero", dataThrough: now },
      { connectorId: "deputy", connectionId: deputy, label: "Deputy", dataThrough: now },
    ],
    authorityByConcept: {
      operational_sales: lightspeed,
      product_master: lightspeed,
      customer_master: lightspeed,
      stock: lightspeed,
      statutory_finance: xero,
      cash_settlement: xero,
      planned_shifts: deputy,
      worked_hours: deputy,
    },
  };
  const publication = Object.hasOwn(options, "publication")
    ? options.publication
    : { registryVersion: semanticRegistry.version, registryHash: "f".repeat(64), activePublicationMatches: true };
  const dependencies: SemanticServiceDependencies = {
    registry: semanticRegistry,
    contextProvider: { async load() { return { ...baseTenant, ...options.tenant }; } },
    database: { queryAsSemanticRole: options.query },
    cache: new MemorySemanticResultCache(() => Date.parse(now)),
    sourceCatalogue: { async listFields() { return []; } },
    dataHealth: { async getForTopic() { return { status: "passed", checks: [] }; } },
    audit: {
      async append(record) { options.audits?.push(record); },
      async promoteSourceField() { return "promotion-fixture"; },
    },
    ...(publication ? { publicationEvidence: { async inspect() { return publication; } } } : {}),
    clock: () => new Date(now),
  };
  return new DefaultSemanticToolExecutor(dependencies);
}

function salesQuery(metric: string) {
  return {
    topic: "sales_performance",
    metrics: [metric],
    dimensions: [],
    filters: [],
    time: absoluteTime(),
    sort: [],
    limit: 20,
    parameters: {},
  };
}

function absoluteTime() {
  return {
    field: "business_date",
    range: { type: "absolute" as const, from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
    compare: "none" as const,
  };
}

function semanticChecks(validation: Readonly<Record<string, unknown>>) {
  const checks = Array.isArray(validation.checks) ? validation.checks : [];
  return checks.filter((candidate): candidate is Readonly<Record<string, unknown>> =>
    Boolean(candidate) && typeof candidate === "object"
      && semanticCheckIds.includes((candidate as Record<string, unknown>).checkId as typeof semanticCheckIds[number]));
}

function check(validation: Readonly<Record<string, unknown>>, checkId: typeof semanticCheckIds[number]) {
  const result = semanticChecks(validation).find((candidate) => candidate.checkId === checkId);
  assert.ok(result, `Missing ${checkId}`);
  return result;
}
