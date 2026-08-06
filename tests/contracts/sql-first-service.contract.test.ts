import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadRegistryFile } from "../../packages/semantic-registry/src/index.js";
import { DefaultSemanticToolExecutor } from "../../services/semantic-query/src/service.js";
import { MemorySemanticResultCache } from "../../services/semantic-query/src/cache.js";
import type {
  SemanticAuditRecord,
  SemanticServiceDependencies,
  TenantSemanticContext,
} from "../../services/semantic-query/src/types.js";

const registry = loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const tenantId = "01J00000000000000000000001";
const now = "2026-08-03T00:00:00.000Z";
const trusted = {
  tenantId,
  role: "owner" as const,
  conversationId: "01J00000000000000000000002",
  turnId: "01J00000000000000000000003",
};

type QueryFn = SemanticServiceDependencies["database"]["queryAsSemanticRole"];

function serviceFor(options: Readonly<{
  query: QueryFn;
  audits?: SemanticAuditRecord[];
  tenant?: Partial<TenantSemanticContext>;
}>): DefaultSemanticToolExecutor {
  const lightspeed = "connection-lightspeed";
  const baseTenant: TenantSemanticContext = {
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters: { active_customer_days: 90, lapsed_customer_days: 180, stock_velocity_days: 30 },
    capabilities: new Set([...registry.metrics.values()].flatMap((metric) => metric.requiredCapabilities)),
    overlayVersion: "fixture-overlay",
    identityGraphVersion: 0,
    identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
    defaults: {},
    dossier: {},
    packVersions: { "lightspeed-r": "1.1.0" },
    sourceWatermarks: { [lightspeed]: now },
    sourceDetails: [
      { connectorId: "lightspeed-r", connectionId: lightspeed, label: "Lightspeed", dataThrough: now },
    ],
    authorityByConcept: {
      operational_sales: lightspeed,
      customer_master: lightspeed,
      stock: lightspeed,
    },
  };
  const dependencies: SemanticServiceDependencies = {
    registry,
    contextProvider: { async load() { return { ...baseTenant, ...options.tenant }; } },
    database: { queryAsSemanticRole: options.query },
    cache: new MemorySemanticResultCache(() => Date.parse(now)),
    sourceCatalogue: { async listFields() { return []; } },
    dataHealth: { async getForTopic() { return { status: "passed", checks: [] }; } },
    audit: {
      async append(record) { options.audits?.push(record); },
      async promoteSourceField() { return "promotion-fixture"; },
    },
    publicationEvidence: {
      async inspect() {
        return { registryVersion: registry.version, registryHash: "f".repeat(64), activePublicationMatches: true };
      },
    },
    clock: () => new Date(now),
  };
  return new DefaultSemanticToolExecutor(dependencies);
}

const CLAIMED_SALES = {
  sql: "SELECT SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f WHERE f.business_date >= '2026-07-01' AND f.business_date < '2026-08-01'",
  purpose: "July net sales",
  claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }],
  time: { from: "2026-07-01", to: "2026-08-01" },
  filters: [],
  limit: 20,
};

test("an attested claim over contracted substrate earns Verified on the sql_first route", async () => {
  const audits: SemanticAuditRecord[] = [];
  const statements: string[] = [];
  const service = serviceFor({
    audits,
    async query(request) {
      statements.push(request.sql);
      // The statement and the governed contract compute the same total; the
      // contract's compiled result column carries the metric's own alias.
      return /albert_exploratory/u.test(request.sql)
        ? { rows: [{ net_sales: "210.0000" }], durationMs: 1 }
        : { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 1 };
    },
  });
  const response = await service.execute("run_sql", CLAIMED_SALES, trusted);

  assert.equal(response.state, "verified");
  assert.equal(response.queryAudit?.route, "sql_first");
  assert.equal(response.validation.status, "passed");
  assert.deepEqual(response.validation.warnings, []);
  const attested = response.validation.checks.find((check) =>
    check.checkId === "claim_attested:commerce.net_sales_ex_gst");
  assert.ok(attested);
  assert.equal(attested.status, "passed");
  const tier = response.validation.checks.find((check) => check.checkId === "evidence_tier");
  assert.ok(tier);
  assert.equal(tier.minimumTier, 3);
  for (const checkId of ["no_fanout", "authority_respected", "golden_fixture_match"]) {
    const check = response.validation.checks.find((candidate) => candidate.checkId === checkId);
    assert.ok(check, `missing ${checkId}`);
    assert.equal(check.status, "passed", checkId);
  }
  // The audit envelope records the claim, never the raw model SQL as ir.
  assert.equal(audits.length, 1);
  const envelope = audits[0]!.input as Record<string, unknown>;
  assert.equal(envelope.route, "sql_first");
  assert.match(String(envelope.sqlDigest), /^[a-f0-9]{64}$/u);
  assert.equal(audits[0]!.state, "verified");
  // The statement itself and the attestation contract both executed.
  assert.ok(statements.length >= 2);
});

test("a divergent claim comes back Qualified with both numbers and the inflation fingerprint", async () => {
  let call = 0;
  const service = serviceFor({
    async query() {
      call += 1;
      // The statement returns an inflated figure; the contract the honest one.
      return call === 1
        ? { rows: [{ net_sales: "630.0000" }], durationMs: 1 }
        : { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 1 };
    },
  });
  const response = await service.execute("run_sql", CLAIMED_SALES, trusted);

  assert.equal(response.state, "qualified");
  const attested = response.validation.checks.find((check) =>
    check.checkId === "claim_attested:commerce.net_sales_ex_gst");
  assert.ok(attested);
  assert.equal(attested.status, "warning");
  assert.equal(attested.agentValue, 630);
  assert.equal(attested.contractValue, 210);
  assert.ok(response.validation.warnings.some((warning) =>
    /630/.test(warning) && /210/.test(warning) && /fingerprint of a multiplying join/u.test(warning)));
});

test("a claimless statement stays exploratory with the promotion advisory", async () => {
  const service = serviceFor({
    async query() { return { rows: [{ median_basket: "42.5000" }], durationMs: 1 }; },
  });
  const response = await service.execute("run_sql", {
    sql: "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY f.signed_net_amount_inc_tax) AS median_basket FROM mart.commerce_sales_event f",
    purpose: "median basket value",
    claims: [],
    filters: [],
    limit: 20,
  }, trusted);

  assert.equal(response.state, "exploratory");
  assert.equal(response.queryAudit?.route, "sql_first");
  assert.ok(response.validation.warnings.some((warning) => /exploratory/iu.test(warning)));
});

test("claims without a declared window are rejected before anything executes", async () => {
  let executed = 0;
  const service = serviceFor({
    async query() { executed += 1; return { rows: [], durationMs: 1 }; },
  });
  await assert.rejects(
    service.execute("run_sql", { ...CLAIMED_SALES, time: undefined }, trusted),
    /declared window/u,
  );
  assert.equal(executed, 0);
});

test("a linter-blocked statement is refused with the specific defect and never executes", async () => {
  let executed = 0;
  const service = serviceFor({
    async query() { executed += 1; return { rows: [], durationMs: 1 }; },
  });
  await assert.rejects(
    service.execute("run_sql", {
      sql: "SELECT SUM(i.stock_value) AS total FROM mart.inventory_health_day i",
      purpose: "total stock value across all time",
      claims: [],
      filters: [],
      limit: 20,
    }, trusted),
    /point-in-time/u,
  );
  assert.equal(executed, 0);
});

test("the runtime canary withholds figures when the join tree provably multiplied a summed fact", async () => {
  const service = serviceFor({
    async query(request) {
      if (/count\(DISTINCT/u.test(request.sql)) {
        // 3 rows over 1 distinct grain: the join tripled the fact.
        return { rows: [{ row_count: "3", distinct_rows: "1" }], durationMs: 1 };
      }
      return { rows: [{ net_sales: "630.0000" }], durationMs: 1 };
    },
  });
  // A join to a table the registry cannot classify: statically permitted,
  // canaried at runtime.
  const response = await service.execute("run_sql", {
    sql: "SELECT SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f JOIN quality.check_result q ON q.tenant_id = f.tenant_id",
    purpose: "net sales joined to quality rows",
    claims: [],
    filters: [],
    limit: 20,
  }, trusted);

  assert.equal(response.state, "unavailable");
  assert.equal(response.data, undefined);
  const canary = response.validation.checks.find((check) =>
    String(check.checkId).startsWith("runtime_fanout_canary:"));
  assert.ok(canary);
  assert.equal(canary.status, "blocked");
  assert.equal(canary.rowCount, 3);
  assert.equal(canary.distinctRows, 1);
  assert.ok(response.validation.warnings.some((warning) => /×3\.00/u.test(warning)));
});

test("a clean canary upgrades only statically-unverified joins, and tier-0 claims stay exploratory", async () => {
  const service = serviceFor({
    async query(request) {
      if (/count\(DISTINCT/u.test(request.sql)) {
        return { rows: [{ row_count: "5", distinct_rows: "5" }], durationMs: 1 };
      }
      if (/albert_exploratory/u.test(request.sql)) {
        return { rows: [{ net_sales: "210.0000" }], durationMs: 1 };
      }
      return { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 1 };
    },
  });
  const response = await service.execute("run_sql", {
    sql: "SELECT SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f JOIN quality.check_result q ON q.tenant_id = f.tenant_id WHERE f.business_date >= '2026-07-01' AND f.business_date < '2026-08-01'",
    purpose: "net sales alongside quality rows",
    claims: [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }],
    time: { from: "2026-07-01", to: "2026-08-01" },
    filters: [],
    limit: 20,
  }, trusted);

  // The canary proved the join preserved grain, so no_fanout passes even
  // though the registry had never heard of the joined relation.
  const fanout = response.validation.checks.find((check) => check.checkId === "no_fanout");
  assert.ok(fanout);
  assert.equal(fanout.status, "passed");
  assert.equal(response.state, "verified");
});

test("an ordered, limited statement carries an ordering proof; unordered truncation carries none", async () => {
  const rows = Array.from({ length: 3 }, (_, index) => ({ category: `c${index}`, net_sales: `${100 - index}` }));
  const service = serviceFor({
    async query() { return { rows, durationMs: 1 }; },
  });
  const ordered = await service.execute("run_sql", {
    sql: "SELECT c.name AS category, SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f JOIN core.product_category c ON c.id = f.product_category_id GROUP BY c.name ORDER BY net_sales DESC LIMIT 3",
    purpose: "top categories",
    claims: [],
    filters: [],
    limit: 20,
  }, trusted);
  assert.deepEqual(ordered.data?.resultWindow, {
    requestedLimit: 3,
    orderedBeforeLimit: true,
    orderBy: [{ columnKey: "net_sales", direction: "desc" }],
  });

  const unordered = await service.execute("run_sql", {
    sql: "SELECT c.name AS category, SUM(f.signed_net_amount_ex_tax) AS net_sales FROM mart.commerce_sales_event f JOIN core.product_category c ON c.id = f.product_category_id GROUP BY c.name",
    purpose: "categories unordered",
    claims: [],
    filters: [],
    limit: 3,
  }, trusted);
  assert.equal(unordered.data?.resultWindow, undefined);
});

test("identical statements hit the bundle cache and re-audit as cache hits", async () => {
  let databaseCalls = 0;
  const audits: SemanticAuditRecord[] = [];
  const service = serviceFor({
    audits,
    async query(request) {
      databaseCalls += 1;
      return /albert_exploratory/u.test(request.sql)
        ? { rows: [{ net_sales: "210.0000" }], durationMs: 1 }
        : { rows: [{ net_sales_ex_gst: "210.0000" }], durationMs: 1 };
    },
  });
  const miss = await service.execute("run_sql", CLAIMED_SALES, trusted);
  const hit = await service.execute("run_sql", CLAIMED_SALES, trusted);

  assert.equal(miss.performance.cacheHit, false);
  assert.equal(hit.performance.cacheHit, true);
  assert.equal(hit.state, miss.state);
  // Statement + attestation on the miss; nothing on the hit.
  assert.equal(databaseCalls, 2);
  assert.equal(audits.length, 2);
  assert.equal(audits[1]!.cacheHit, true);
  assert.equal(audits[0]!.route, "sql_first");
  assert.equal(audits[1]!.route, "sql_first");
});

test("missing authority evidence blocks certification of a claimed statement", async () => {
  const service = serviceFor({
    tenant: { authorityByConcept: {}, sourceDetails: [] },
    async query() { return { rows: [{ net_sales: "210.0000" }], durationMs: 1 }; },
  });
  const response = await service.execute("run_sql", CLAIMED_SALES, trusted);
  assert.equal(response.state, "unavailable");
  const authority = response.validation.checks.find((check) => check.checkId === "authority_respected");
  assert.ok(authority);
  assert.equal(authority.status, "blocked");
});
