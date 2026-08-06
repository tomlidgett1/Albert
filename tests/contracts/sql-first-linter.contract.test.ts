import assert from "node:assert/strict";
import test from "node:test";
import { loadRegistryFile, lintSqlFirstStatement } from "../../packages/semantic-registry/src/index.js";

const registry = loadRegistryFile("packages/semantic-registry/registry/registry.yaml");

function lint(sql: string, claims: Parameters<typeof lintSqlFirstStatement>[1] = []) {
  return lintSqlFirstStatement(sql, claims, registry);
}

function blocks(result: ReturnType<typeof lint>) {
  return result.violations.filter((violation) => violation.severity === "block");
}

test("a clean single-fact query over contracted dimensions reconstructs compiler-shaped evidence", () => {
  const result = lint(`
    SELECT c.name AS category, SUM(f.signed_net_amount_ex_tax) AS net_sales
    FROM mart.commerce_sales_event f
    JOIN core.product_category c ON c.id = f.product_category_id
    WHERE f.business_date >= '2026-05-01' AND f.business_date < '2026-08-01'
    GROUP BY c.name
    ORDER BY net_sales DESC
    LIMIT 20
  `, [{ metricId: "commerce.net_sales_ex_gst", column: "net_sales" }]);

  assert.equal(blocks(result).length, 0);
  assert.equal(result.evidence.planKind, "single_fact");
  assert.deepEqual(result.evidence.factIds, ["commerce_sales_event"]);
  assert.deepEqual(result.evidence.alignOn, []);
  assert.ok(result.evidence.joins.every((join) =>
    join.cardinality === "many_to_one" || join.cardinality === "one_to_one"));
  assert.equal(result.evidence.metrics.length, 1);
  const metric = result.evidence.metrics[0]!;
  assert.equal(metric.metricId, "commerce.net_sales_ex_gst");
  assert.equal(metric.baseFact, "commerce_sales_event");
  assert.equal(metric.authority, "operational_sales");
  assert.equal(result.minimumFactTier, 3);
  const scope = result.factScopes[0]!;
  assert.equal(scope.staticallyClean, true);
  assert.equal(scope.grainKey, "id");
  assert.match(scope.fromText ?? "", /mart\.commerce_sales_event/u);
  assert.match(scope.whereText ?? "", /business_date/u);
});

test("summing a snapshot level across its axis is blocked with the specific diagnosis", () => {
  const result = lint(`
    SELECT SUM(i.stock_value) AS total_stock_value
    FROM mart.inventory_health_day i
    WHERE i.business_date >= '2026-01-01'
  `);
  const violation = blocks(result).find((item) => item.code === "snapshot_summed_across_axis");
  assert.ok(violation, "snapshot sum must block");
  assert.match(violation.message, /SUM\(stock_value\)/u);
  assert.match(violation.message, /point-in-time/u);
});

test("summing a snapshot level with the date pinned by equality is allowed", () => {
  const result = lint(`
    SELECT s.name AS stock_location, SUM(i.stock_value) AS stock_value
    FROM mart.inventory_health_day i
    JOIN core.stock_location s ON s.id = i.stock_location_id
    WHERE i.snapshot_date = '2026-08-01'
    GROUP BY s.name
  `);
  assert.equal(blocks(result).length, 0);
});

test("summing a snapshot level grouped by its date is allowed", () => {
  const result = lint(`
    SELECT i.snapshot_date, SUM(i.quantity_on_hand) AS units
    FROM mart.inventory_health_day i
    GROUP BY i.snapshot_date
  `);
  assert.equal(blocks(result).length, 0);
});

test("the classic header-by-line inflation is blocked in the fatal direction only", () => {
  // Order-level value summed while lines repeat each order: fatal.
  const inflated = lint(`
    SELECT SUM(o.net_amount_ex_tax) AS order_value
    FROM mart.customer_order_activity o
    JOIN mart.commerce_sales_event l ON l.sale_order_id = o.id
  `);
  const violation = blocks(inflated).find((item) => item.code === "fanout_measure_sum");
  assert.ok(violation, "summing the multiplied fact must block");
  assert.match(violation.message, /commerce_sales_event repeats each customer_order_activity row/u);

  // Line-level value summed with the order header joined in: correct and common.
  const legitimate = lint(`
    SELECT SUM(l.signed_net_amount_ex_tax) AS net_sales
    FROM mart.commerce_sales_event l
    JOIN mart.customer_order_activity o ON o.id = l.sale_order_id
  `);
  assert.ok(!blocks(legitimate).some((item) => item.code === "fanout_measure_sum"));
});

test("joining order lines to time entries blocks the sum in both directions", () => {
  const result = lint(`
    SELECT SUM(s.signed_net_amount_ex_tax) AS sales, SUM(w.labour_cost) AS labour
    FROM mart.commerce_sales_event s
    JOIN mart.workforce_day_worker_location w
      ON w.business_date = s.business_date AND w.location_id = s.location_id
  `);
  const fanouts = blocks(result).filter((item) => item.code === "fanout_measure_sum");
  assert.equal(fanouts.length, 2, "both sums are inflated by the m:n day join");
  assert.match(fanouts.map((item) => item.message).join(" "), /aligned mart/u);
});

test("aggregating each fact in its own scope and joining the aggregates is a valid composite", () => {
  const result = lint(`
    WITH sales AS (
      SELECT s.business_date, s.location_id, SUM(s.signed_net_amount_ex_tax) AS net_sales
      FROM mart.commerce_sales_event s
      GROUP BY s.business_date, s.location_id
    ), labour AS (
      SELECT w.business_date, w.location_id, SUM(w.labour_cost) AS labour_cost
      FROM mart.workforce_day_worker_location w
      GROUP BY w.business_date, w.location_id
    )
    SELECT sales.business_date, sales.net_sales, labour.labour_cost
    FROM sales
    JOIN labour ON labour.business_date = sales.business_date AND labour.location_id = sales.location_id
  `);
  assert.equal(blocks(result).length, 0);
  assert.equal(result.evidence.planKind, "aggregate_then_align");
  assert.deepEqual([...result.evidence.factIds].sort(), ["commerce_sales_event", "workforce_day_worker_location"]);
  assert.deepEqual(result.evidence.alignOn, ["business_date", "location_id"]);
});

test("summing a key or attribute as if it were a measure is blocked", () => {
  const result = lint(`
    SELECT SUM(f.location_id) AS nonsense
    FROM mart.commerce_sales_event f
  `);
  const violation = blocks(result).find((item) => item.code === "non_measure_aggregated");
  assert.ok(violation);
  assert.match(violation.message, /key or attribute/u);
  assert.match(violation.message, /signed_net_amount_ex_tax/u);
});

test("a relation the registry has never heard of stays permitted but records unverified evidence", () => {
  const result = lint(`
    SELECT q.check_id, SUM(f.signed_net_amount_ex_tax) AS net_sales
    FROM mart.commerce_sales_event f
    JOIN quality.check_result q ON q.tenant_id = f.tenant_id
    GROUP BY q.check_id
  `);
  assert.equal(blocks(result).length, 0, "open by default: unknown relations do not block");
  assert.ok(result.evidence.joins.some((join) => join.cardinality === "unverified"));
  assert.equal(result.factScopes[0]!.staticallyClean, false);
});

test("a revenue claim with no refund treatment warns without blocking", () => {
  const result = lint(`
    SELECT SUM(f.sale_amount_inc_tax) AS takings
    FROM mart.commerce_sales_event f
  `, [{ metricId: "commerce.gross_takings_inc_gst", column: "takings" }]);
  assert.equal(blocks(result).length, 0);
  const warning = result.violations.find((item) => item.code === "refund_handling_unstated");
  assert.ok(warning);
  assert.equal(warning.severity, "warn");
  assert.match(warning.message, /gross of returns/u);
});

test("a signed-column aggregation satisfies the refund lens without a warning", () => {
  const result = lint(`
    SELECT SUM(f.signed_net_amount_inc_tax) AS takings
    FROM mart.commerce_sales_event f
  `, [{ metricId: "commerce.gross_takings_inc_gst", column: "takings" }]);
  assert.ok(!result.violations.some((item) => item.code === "refund_handling_unstated"));
});

test("a claim naming a concept outside the registry is blocked by name", () => {
  const result = lint(
    "SELECT SUM(f.signed_net_amount_ex_tax) AS x FROM mart.commerce_sales_event f",
    [{ metricId: "commerce.total_vibes", column: "x" }],
  );
  const violation = blocks(result).find((item) => item.code === "unknown_claim_metric");
  assert.ok(violation);
  assert.match(violation.message, /commerce\.total_vibes/u);
});

test("claim evidence carries dependency metrics and snapshot accesses for the invariant checks", () => {
  const result = lint(`
    SELECT i.snapshot_date, SUM(i.quantity_on_hand) AS units
    FROM mart.inventory_health_day i
    GROUP BY i.snapshot_date
  `, [{ metricId: "inventory.stock_on_hand_units", column: "units" }]);
  const metric = result.evidence.metrics[0]!;
  assert.ok(metric.testKinds.includes("snapshot_not_summed"));
  assert.ok(metric.snapshotAccesses.length > 0);
  assert.ok(metric.snapshotAccesses.every((access) => access.factId === "inventory_health_day"));

  const ratio = lint(
    "SELECT 1 AS x FROM mart.commerce_sales_event f",
    [{ metricId: "commerce.avg_order_value", column: "x" }],
  );
  const ratioMetric = ratio.evidence.metrics[0]!;
  assert.deepEqual(
    [...ratioMetric.dependencyMetricIds].sort(),
    ["commerce.gross_takings_inc_gst", "commerce.transactions"],
  );
});

test("statement text that defies the reader degrades to a warning, never a guess", () => {
  const result = lint("SELECT * FROM (SELECT 1");
  assert.ok(result.violations.some((item) => item.code === "unreadable_statement"));
  assert.ok(blocks(result).length === 0);
});
