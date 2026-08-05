import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { compileSemanticQuery } from "../../packages/compiler/src/index.js";
import { loadRegistryFile } from "../../packages/semantic-registry/src/index.js";
import {
  DefaultSemanticToolExecutor,
  MemorySemanticResultCache,
  type SemanticServiceDependencies,
} from "../../services/semantic-query/src/index.js";

const tenantId = "01J00000000000000000000001";
const registry = loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const migration = readFileSync(
  resolve("infra/migrations/analytical/0074_m4_live_analytical_correctness.sql"),
  "utf8",
);
const settlementMigration = readFileSync(
  resolve("infra/migrations/analytical/0075_m4_pos_bank_settlement_bridge.sql"),
  "utf8",
);

test("live marts exclude incomplete operational events and preserve unknown measures", () => {
  assert.match(migration, /WHERE line\.order_status = 'completed'[\s\S]*AND NOT line\.voided[\s\S]*AND NOT line\.internal_transaction/u);
  assert.match(migration, /WHERE status = 'approved'/u);
  assert.doesNotMatch(migration, /COALESCE\(refund\.total_cost_reversed\s*,\s*0\)/u);
  assert.match(migration, /ALTER COLUMN overtime_minutes DROP NOT NULL/u);
  assert.match(migration, /actual\.overtime_minutes/u);
  assert.doesNotMatch(migration, /COALESCE\(actual\.overtime_minutes\s*,\s*0\)/u);
});

test("inventory mart uses a bounded dense calendar and finance uses eligible deduplicated facts", () => {
  assert.match(migration, /JOIN core\.calendar_day AS day/u);
  assert.match(migration, /BETWEEN bounds\.first_snapshot_date AND bounds\.last_snapshot_date/u);
  assert.match(migration, /ROWS BETWEEN 29 PRECEDING AND CURRENT ROW/u);
  assert.match(migration, /posting\.link_type = 'accounting_posting_of'/u);
  assert.match(migration, /posting\.to_object_type = 'ManualJournals'/u);
  assert.match(migration, /line\.status = 'posted'/u);
  assert.match(migration, /status IN \('authorised','paid','posted','reconciled'\)/u);
  assert.match(migration, /invoice_observation[\s\S]*max\(observed_at\)::date AS snapshot_date/u);
});

test("compiler calculates stock cover at the requested aggregate grain and ignores null snapshot rows", () => {
  const compiled = compileSemanticQuery({
    kind: "single",
    topic: "inventory_health",
    metrics: ["inventory.stock_cover_days"],
    dimensions: ["product.category"],
    filters: [],
    time: { field: "snapshot_date", range: { type: "last_n_days", days: 1 }, compare: "none" },
    sort: [],
    limit: 100,
    parameters: {},
  }, registry, {
    tenantId,
    role: "owner",
    capabilities: new Set(["inventory.balances", "commerce.order_lines"]),
    now: "2026-08-03T00:00:00.000Z",
    timezone: "Australia/Melbourne",
    tenantParameters: { stock_velocity_days: 14 },
  });

  assert.match(compiled.sql, /SUM\(f\."units_sold"\)[\s\S]*\/ CAST\(\$\d+ AS numeric\)/u);
  // Rows with no observed balance never define the latest snapshot. This was a
  // correlated subquery per row until it made every inventory question time
  // out; the guarantee now rides on the window's FILTER.
  assert.match(compiled.sql, /FILTER \(WHERE base\."quantity_on_hand" IS NOT NULL\) OVER \(PARTITION BY /u);
  assert.ok(compiled.parameters.includes(14));
  assert.throws(() => compileSemanticQuery({
    kind: "single",
    topic: "inventory_health",
    metrics: ["inventory.stock_cover_days"],
    dimensions: ["business_date"],
    filters: [],
    time: { field: "snapshot_date", range: { type: "last_n_days", days: 1 }, compare: "none" },
    sort: [],
    limit: 100,
    parameters: {},
  }, registry, {
    tenantId,
    role: "owner",
    capabilities: new Set(["inventory.balances", "commerce.order_lines"]),
    now: "2026-08-03T00:00:00.000Z",
    timezone: "Australia/Melbourne",
    tenantParameters: { stock_velocity_days: 14 },
  }), /business_date is not allowed/u);
});

test("semantic execution measures cost coverage and blocks partial-cost verification across cache hits", async () => {
  let databaseCalls = 0;
  const service = new DefaultSemanticToolExecutor(dependencies(async () => {
    databaseCalls += 1;
    return {
      rows: [{
        gross_margin: "80.0000",
        __coverage_eligible__gross_margin: "2",
        __coverage_observed__gross_margin: "1",
        __currency_codes__gross_margin: "AUD",
      }],
      durationMs: 1,
    };
  }));
  const input = {
    topic: "sales_performance",
    metrics: ["commerce.gross_margin"],
    dimensions: [],
    filters: [],
    time: {
      field: "business_date",
      range: { type: "absolute", from: "2026-08-01T00:00:00.000Z", to: "2026-08-04T00:00:00.000Z" },
      compare: "none",
    },
    sort: [],
    limit: 20,
    parameters: {},
  };
  const trusted = {
    tenantId,
    role: "owner" as const,
    conversationId: "01J00000000000000000000002",
    turnId: "01J00000000000000000000003",
  };

  const first = await service.execute("run_semantic_query", input, trusted);
  const cached = await service.execute("run_semantic_query", input, trusted);
  assert.equal(first.state, "unavailable");
  assert.equal(cached.state, "unavailable");
  assert.equal(first.data, undefined);
  assert.equal(databaseCalls, 1);
  assert.ok(first.validation.checks.some((check) =>
    check.checkId === "slice_cost_coverage:gross_margin" && check.status === "blocked"));
});

test("semantic execution blocks a finance slice that would sum multiple currencies", async () => {
  const service = new DefaultSemanticToolExecutor(dependencies(async () => ({
    rows: [{
      accrued_revenue: "100.0000",
      __currency_codes__accrued_revenue: "AUD,NZD",
    }],
    durationMs: 1,
  }), new Set(["finance.journals"])));
  const result = await service.execute("run_semantic_query", {
    topic: "profitability_cash",
    metrics: ["finance.accrued_revenue"],
    dimensions: [],
    filters: [],
    time: {
      field: "business_date",
      range: { type: "absolute", from: "2026-08-01T00:00:00.000Z", to: "2026-08-04T00:00:00.000Z" },
      compare: "none",
    },
    sort: [],
    limit: 20,
    parameters: {},
  }, {
    tenantId,
    role: "owner",
    conversationId: "01J00000000000000000000004",
    turnId: "01J00000000000000000000005",
  });

  assert.equal(result.state, "unavailable");
  assert.ok(result.validation.checks.some((check) =>
    check.checkId === "slice_single_currency:accrued_revenue" && check.status === "blocked"));
});

test("POS tenders and Xero bank receipts compile through a governed settlement bridge", () => {
  assert.match(settlementMigration, /CREATE OR REPLACE FUNCTION core\.refresh_daily_settlement_links/u);
  assert.match(settlementMigration, /rank\(\) OVER[\s\S]*PARTITION BY candidate\.pos_group_key/u);
  assert.match(settlementMigration, /rank\(\) OVER[\s\S]*PARTITION BY candidate\.bank_group_key/u);
  assert.match(settlementMigration, /'settlement_of'/u);
  assert.match(settlementMigration, /'settlement-daily-exact-v1'/u);
  assert.match(settlementMigration, /CREATE OR REPLACE VIEW mart\.settlement_reconciliation_aligned/u);
  assert.match(settlementMigration, /'same_day_unlinked'/u);

  const compiled = compileSemanticQuery({
    kind: "composite",
    topic: "reconciliation",
    metrics: ["composites.pos_to_bank_variance"],
    queries: [
      {
        topic: "reconciliation",
        metrics: ["commerce.tender_amount"],
        dimensions: ["business_date", "location"],
        filters: [],
        time: { field: "business_date", range: { type: "absolute", from: "2026-02-10T00:00:00.000Z", to: "2026-02-11T00:00:00.000Z" }, compare: "none" },
        parameters: {},
      },
      {
        topic: "profitability_cash",
        metrics: ["finance.cash_receipts"],
        dimensions: ["business_date", "location"],
        filters: [],
        time: { field: "business_date", range: { type: "absolute", from: "2026-02-10T00:00:00.000Z", to: "2026-02-11T00:00:00.000Z" }, compare: "none" },
        parameters: {},
      },
    ],
    alignOn: ["business_date", "location"],
    sort: [],
    limit: 20,
    parameters: {},
  }, registry, {
    tenantId,
    role: "owner",
    capabilities: new Set(["commerce.order_lines", "commerce.payments", "finance.journals", "finance.bank_transactions"]),
    now: "2026-08-03T00:00:00.000Z",
    timezone: "Australia/Melbourne",
  });

  assert.match(compiled.sql, /FROM "core"\."commerce_payment"/u);
  assert.match(compiled.sql, /FROM "mart"\."finance_day_location"/u);
  assert.match(compiled.sql, /core\.event_link settlement_link/u);
  assert.match(compiled.sql, /"pos_to_bank_variance"/u);
  assert.ok(compiled.resultColumns.includes("tender_amount"));
  assert.ok(compiled.resultColumns.includes("cash_receipts"));
  assert.ok(compiled.resultColumns.includes("pos_to_bank_variance"));
});

test("an unlinked Tuesday bank shortfall is returned as qualified evidence", async () => {
  const service = new DefaultSemanticToolExecutor(dependencies(async () => ({
    rows: [{
      business_date: "2026-02-10",
      location: "Carlton",
      tender_amount: "165.0000",
      cash_receipts: "150.0000",
      pos_to_bank_variance: "15.0000",
      __settlement_eligible__tender_amount: "1",
      __settlement_linked__tender_amount: "0",
      __currency_codes__tender_amount: "AUD",
      __currency_codes__cash_receipts: "AUD",
    }],
    durationMs: 1,
  }), new Set(["commerce.order_lines", "commerce.payments", "finance.journals", "finance.bank_transactions"])));
  const result = await service.execute("run_semantic_query", {
    kind: "composite",
    topic: "reconciliation",
    metrics: ["composites.pos_to_bank_variance"],
    queries: [
      {
        topic: "reconciliation", metrics: ["commerce.tender_amount"], dimensions: ["business_date", "location"], filters: [],
        time: { field: "business_date", range: { type: "absolute", from: "2026-02-10T00:00:00.000Z", to: "2026-02-11T00:00:00.000Z" }, compare: "none" }, parameters: {},
      },
      {
        topic: "profitability_cash", metrics: ["finance.cash_receipts"], dimensions: ["business_date", "location"], filters: [],
        time: { field: "business_date", range: { type: "absolute", from: "2026-02-10T00:00:00.000Z", to: "2026-02-11T00:00:00.000Z" }, compare: "none" }, parameters: {},
      },
    ],
    alignOn: ["business_date", "location"], sort: [], limit: 20, parameters: {},
  }, {
    tenantId, role: "owner", conversationId: "01J00000000000000000000006", turnId: "01J00000000000000000000007",
  });

  assert.equal(result.state, "qualified");
  assert.deepEqual(result.data?.rows, [{
    business_date: "2026-02-10",
    location: "Carlton",
    tender_amount: "165.0000",
    cash_receipts: "150.0000",
    pos_to_bank_variance: "15.0000",
  }]);
  assert.ok(result.validation.checks.some((check) =>
    check.checkId === "slice_settlement_bridge_coverage:tender_amount" && check.status === "warning"));
});

test("nightly reconciliation schedules one coordinator that fans out unfiltered identity scans", () => {
  const operations = readFileSync(resolve("infra/migrations/control-plane/0003_m2_ingestion_operations.sql"), "utf8");
  const bootstrap = readFileSync(resolve("infra/bootstrap/control_plane_role.sql"), "utf8");
  const worker = readFileSync(resolve("services/sync-workers/src/worker.ts"), "utf8");
  const lightspeed = readFileSync(resolve("connectors/lightspeed-r/index.ts"), "utf8");
  const schedulerStart = operations.indexOf("CREATE OR REPLACE FUNCTION control_plane.enqueue_nightly_reconciliation_sweeps");
  const scheduler = operations.slice(schedulerStart, operations.indexOf("CREATE OR REPLACE FUNCTION control_plane.expire_oauth_sessions", schedulerStart));

  assert.match(bootstrap, /'albert-nightly-reconciliation'[\s\S]*enqueue_nightly_reconciliation_sweeps/u);
  assert.match(scheduler, /'reconciliationSweepId', sweep_id/u);
  assert.match(scheduler, /'reconcile-coordinator:' \|\| candidate\.connection_id/u);
  assert.doesNotMatch(scheduler, /'stream', candidate\.stream/u);
  assert.match(
    worker,
    /connector\.reconciliation_sync\(context, stream,[\s\S]*?job\.lookbackFrom[\s\S]*?job\.lookbackTo/u,
  );
  assert.match(lightspeed, /mode === "reconciliation" && reconciliationPhase !== "late_edits"/u);
});

function dependencies(
  query: SemanticServiceDependencies["database"]["queryAsSemanticRole"],
  capabilities = new Set(["commerce.order_lines", "commerce.order_lines.cost"]),
): SemanticServiceDependencies {
  return {
    registry,
    contextProvider: {
      async load() {
        return {
          timezone: "Australia/Melbourne",
          tradingDayCutoff: "00:00",
          fiscalYearStartMonth: 7,
          fiscalYearStartDay: 1,
          weekStartsOn: 1,
          tenantParameters: { active_customer_days: 90, lapsed_customer_days: 180, stock_velocity_days: 30 },
          capabilities,
          overlayVersion: "overlay-live-correctness",
          identityGraphVersion: 0,
          identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
          defaults: {},
          dossier: {},
          packVersions: { lightspeed: "fixture", xero: "fixture" },
          sourceWatermarks: {
            "connection-lightspeed": "2026-08-03T00:00:00.000Z",
            "connection-xero": "2026-08-03T00:00:00.000Z",
          },
          sourceDetails: [
            { connectorId: "lightspeed", connectionId: "connection-lightspeed", label: "Lightspeed", dataThrough: "2026-08-03T00:00:00.000Z" },
            { connectorId: "xero", connectionId: "connection-xero", label: "Xero", dataThrough: "2026-08-03T00:00:00.000Z" },
          ],
          authorityByConcept: {
            operational_sales: "connection-lightspeed",
            statutory_finance: "connection-xero",
            cash_settlement: "connection-xero",
          },
        };
      },
    },
    database: { queryAsSemanticRole: query },
    cache: new MemorySemanticResultCache(() => Date.parse("2026-08-03T00:00:00.000Z")),
    sourceCatalogue: { async listFields() { return []; } },
    dataHealth: { async getForTopic() { return { status: "passed", checks: [] }; } },
    audit: { async append() {}, async promoteSourceField() { return "promotion-live-correctness"; } },
    publicationEvidence: {
      async inspect() {
        return { registryVersion: registry.version, registryHash: "f".repeat(64), activePublicationMatches: true };
      },
    },
    clock: () => new Date("2026-08-03T00:00:00.000Z"),
  };
}
