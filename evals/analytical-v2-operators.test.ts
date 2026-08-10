import assert from "node:assert/strict";
import test from "node:test";

import { runAnalyticalOperatorV2 } from "../packages/analytics-v2/src/operators.js";

test("contribution and gross-margin operators reconcile exactly", () => {
  const contribution = runAnalyticalOperatorV2(
    {
      operatorId: "period_contribution",
      current: [
        { key: "a", label: "A", value: "120" },
        { key: "b", label: "B", value: "80" },
      ],
      comparison: [
        { key: "a", label: "A", value: "100" },
        { key: "b", label: "B", value: "70" },
      ],
    },
    ["current", "comparison"],
  );
  assert.equal(contribution.output.totalChange, "30");
  assert.equal(contribution.validation.passed, true);

  const margin = runAnalyticalOperatorV2(
    {
      operatorId: "gross_margin_bridge",
      currentRevenue: "200",
      currentCost: "120",
      comparisonRevenue: "170",
      comparisonCost: "100",
    },
    ["margin-current", "margin-prior"],
  );
  assert.deepEqual(
    {
      revenue: margin.output.revenueEffect,
      cost: margin.output.costEffect,
      change: margin.output.totalChange,
    },
    { revenue: "30", cost: "-20", change: "10" },
  );
});

test("operators fail safely at zero denominators and expose assumptions", () => {
  const returns = runAnalyticalOperatorV2(
    {
      operatorId: "return_rate",
      grossSales: "0",
      returnValue: "10",
      soldUnits: "0",
      returnedUnits: "2",
    },
    ["returns"],
  );
  assert.equal(returns.output.valueReturnRate, null);
  assert.equal(returns.output.unitReturnRate, null);

  const opportunity = runAnalyticalOperatorV2(
    {
      operatorId: "stockout_opportunity",
      items: [
        {
          key: "sku-1",
          unavailableDays: "2",
          averageDailyUnits: "3",
          unitMargin: "4",
          availabilityFactor: "0.5",
        },
      ],
    },
    ["stock"],
  );
  assert.equal(opportunity.output.totalOpportunity, "12");
  assert.ok(opportunity.limitations.length > 0);
});

test("operator domain contracts reject misleading or silently rounded inputs", () => {
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "customer_retention",
          cohorts: [{ cohort: "2026-01", acquired: "10", retained: "11" }],
        },
        ["cohorts"],
      ),
    /cannot exceed acquired/iu,
  );
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "stockout_opportunity",
          items: [
            {
              key: "sku-1",
              unavailableDays: "2",
              averageDailyUnits: "3",
              unitMargin: "4",
              availabilityFactor: "1.2",
            },
          ],
        },
        ["stock"],
      ),
    /between zero and one/iu,
  );
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "dimension_contribution",
          current: [{ key: "a", label: "A", value: "1.0000001" }],
          comparison: [],
        },
        ["dimensions"],
      ),
    /six-decimal/iu,
  );
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "return_rate",
          grossSales: "100",
          returnValue: "5",
          returnedUnits: "1",
        },
        ["returns"],
      ),
    /supplied together/iu,
  );
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "profitability_bridge",
          revenue: "100",
          cogs: "50",
          operatingExpenses: "20",
          priorRevenue: "90",
        },
        ["profit"],
      ),
    /must be supplied together/iu,
  );
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "constraint_controllability",
          opportunities: [
            {
              key: "stock",
              value: "100",
              controllability: "high",
              constrained: true,
            },
          ],
        },
        ["constraints"],
      ),
    /constraint reason/iu,
  );
});

test("operator artifacts are reproducible and bind their source evidence", () => {
  const input = {
    operatorId: "pos_xero_reconciliation" as const,
    posRevenue: "100",
    xeroRevenue: "99.5",
    tolerance: "1",
  };
  const first = runAnalyticalOperatorV2(input, ["xero", "lightspeed"]);
  const second = runAnalyticalOperatorV2(input, ["xero", "lightspeed"]);
  assert.equal(first.artifactHash, second.artifactHash);
  assert.equal(first.output.withinTolerance, true);
  assert.match(first.limitations[0] ?? "", /timing|tax|posting/iu);
});

test("price-volume-mix separates true mix and reconciles new assortment effects", () => {
  const artifact = runAnalyticalOperatorV2(
    {
      operatorId: "price_volume_mix",
      items: [
        {
          key: "a",
          currentPrice: "11",
          comparisonPrice: "10",
          currentVolume: "15",
          comparisonVolume: "10",
          population: "continuing",
        },
        {
          key: "b",
          currentPrice: "18",
          comparisonPrice: "20",
          currentVolume: "5",
          comparisonVolume: "10",
          population: "continuing",
        },
      ],
    },
    ["execution:current", "execution:comparison"],
  );
  assert.deepEqual(
    {
      price: artifact.output.priceEffect,
      volume: artifact.output.volumeEffect,
      mix: artifact.output.mixEffect,
      total: artifact.output.totalChange,
    },
    { price: "5", volume: "0", mix: "-50", total: "-45" },
  );
  assert.match(artifact.validation.checks.join(" "), /reconcile exactly/iu);
});

test("trend analysis emits an ordered deterministic mean-shift candidate", () => {
  const artifact = runAnalyticalOperatorV2(
    {
      operatorId: "trend_anomaly",
      points: [
        { period: "2026-01", value: "10" },
        { period: "2026-02", value: "10" },
        { period: "2026-03", value: "20" },
        { period: "2026-04", value: "20" },
      ],
      zThreshold: 2.5,
    },
    ["execution:trend"],
  );
  assert.deepEqual(artifact.output.changePoint, {
    index: 2,
    period: "2026-03",
    beforeMean: "10",
    afterMean: "20",
    difference: "10",
    direction: "increase",
  });
  assert.throws(
    () =>
      runAnalyticalOperatorV2(
        {
          operatorId: "trend_anomaly",
          points: [
            { period: "2026-02", value: "10" },
            { period: "2026-01", value: "10" },
            { period: "2026-03", value: "20" },
            { period: "2026-04", value: "20" },
          ],
        },
        ["execution:trend"],
      ),
    /strictly increasing/iu,
  );
});

test("profitability bridge attributes the complete operating-profit movement", () => {
  const artifact = runAnalyticalOperatorV2(
    {
      operatorId: "profitability_bridge",
      revenue: "120",
      cogs: "55",
      operatingExpenses: "30",
      priorRevenue: "100",
      priorCogs: "50",
      priorOperatingExpenses: "25",
    },
    ["execution:profit-current", "execution:profit-prior"],
  );
  assert.deepEqual(
    {
      change: artifact.output.change,
      revenue: artifact.output.revenueEffect,
      cogs: artifact.output.cogsEffect,
      operatingExpenses: artifact.output.operatingExpenseEffect,
    },
    {
      change: "10",
      revenue: "20",
      cogs: "-5",
      operatingExpenses: "-5",
    },
  );
});

test("operator artifacts require unique evidence and are deeply immutable", () => {
  const input = {
    operatorId: "pareto_concentration" as const,
    items: [{ key: "a", label: "A", value: "100" }],
  };
  assert.throws(() => runAnalyticalOperatorV2(input, []), /at least one/iu);
  assert.throws(
    () => runAnalyticalOperatorV2(input, ["result", "result"]),
    /unique/iu,
  );
  const first = runAnalyticalOperatorV2(input, ["z", "a"]);
  const second = runAnalyticalOperatorV2(input, ["a", "z"]);
  assert.equal(first.artifactHash, second.artifactHash);
  assert.deepEqual(first.sourceResultIds, ["a", "z"]);
  assert.equal(Object.isFrozen(first.output), true);
  assert.equal(Object.isFrozen(first.output.items), true);
});
