import assert from "node:assert/strict";
import test from "node:test";
import { codexDeriveToolInputSchema } from "../../packages/albert-codex/src/contracts.ts";
import {
  codexClaimCandidates,
  deriveCodexResult,
  validateCodexFinalAnswer,
  type CodexEvidenceResult,
} from "../../packages/albert-codex/src/semantic-runtime.ts";

const provenance = {
  sources: [{ connector: "lightspeed" as const, label: "Cube · lightspeed", dataThrough: "2026-08-20" }],
  timeRange: { label: "Last 12 months", start: "2025-08-01", end: "2026-07-31", timezone: "Australia/Melbourne" },
  definitions: [],
  semanticBundleHash: "fixture",
  identityGraph: { version: 0, hash: "fixture" },
};

const salesByEmployee: CodexEvidenceResult = {
  resultId: "01J00000000000000000000201",
  topic: "Employee sales",
  view: "sales_analytics",
  connector: "lightspeed",
  query: {
    measures: ["sales_analytics.gross_profit"],
    dimensions: ["sales_analytics.employees_full_name"],
    order: { "sales_analytics.gross_profit": "desc" },
    limit: 100,
  },
  queryYaml: "fixture-sales",
  columns: [
    { key: "sales_analytics.employees_full_name", label: "Staff member", type: "string" },
    { key: "sales_analytics.gross_profit", label: "Gross profit", type: "currency", currency: "AUD" },
  ],
  rows: [
    { "sales_analytics.employees_full_name": "Avery Example", "sales_analytics.gross_profit": 1000 },
    { "sales_analytics.employees_full_name": "Blake Sample", "sales_analytics.gross_profit": 900 },
    { "sales_analytics.employees_full_name": "Casey Duplicate", "sales_analytics.gross_profit": 400 },
  ],
  provenance,
  executionMs: 5,
  rowCount: 3,
};

const hoursByEmployee: CodexEvidenceResult = {
  resultId: "01J00000000000000000000202",
  topic: "Worked hours",
  view: "workforce_analytics",
  connector: "deputy",
  query: {
    measures: ["workforce_analytics.hours_worked"],
    dimensions: ["workforce_analytics.worked_by"],
    order: { "workforce_analytics.hours_worked": "desc" },
    limit: 100,
  },
  queryYaml: "fixture-hours",
  columns: [
    { key: "workforce_analytics.worked_by", label: "Staff member", type: "string" },
    { key: "workforce_analytics.hours_worked", label: "Hours worked", type: "number" },
  ],
  rows: [
    { "workforce_analytics.worked_by": "Avery Example", "workforce_analytics.hours_worked": 100 },
    { "workforce_analytics.worked_by": "Blake Sample", "workforce_analytics.hours_worked": 50 },
    // Duplicate labels are ambiguous, so trusted alignment must drop them.
    { "workforce_analytics.worked_by": "Casey Duplicate", "workforce_analytics.hours_worked": 10 },
    { "workforce_analytics.worked_by": "Casey Duplicate", "workforce_analytics.hours_worked": 12 },
  ],
  provenance: {
    ...provenance,
    sources: [{ connector: "deputy", label: "Cube · deputy", dataThrough: "2026-08-16" }],
  },
  executionMs: 5,
  rowCount: 4,
};

test("derive_result computes trusted cross-result per-unit rates with exact-label alignment", () => {
  const request = codexDeriveToolInputSchema.parse({
    caption: "Gross profit per worked hour",
    resultId: salesByEmployee.resultId,
    alignWith: {
      resultId: hoursByEmployee.resultId,
      labelKey: "sales_analytics.employees_full_name",
      sourceLabelKey: "workforce_analytics.worked_by",
    },
    expressions: [{
      name: "gross_profit_per_hour",
      label: "Gross profit per worked hour",
      operation: "ratio",
      leftKey: "sales_analytics.gross_profit",
      rightKey: "workforce_analytics.hours_worked",
    }],
  });
  const decision = deriveCodexResult({ request, evidence: [salesByEmployee, hoursByEmployee] });
  assert.ok(decision.ok, JSON.stringify(decision));
  const derived = decision.result;
  assert.equal(derived.view, "derived_result");
  // Casey Duplicate has two hour rows and must be excluded by the alignment.
  assert.equal(derived.rowCount, 2);
  // Blake: 900 / 50 = 18 beats Avery: 1000 / 100 = 10 — the tool sorts by the
  // derived column so ranked host claims become available.
  assert.equal(derived.rows[0]?.["sales_analytics.employees_full_name"], "Blake Sample");
  assert.equal(derived.rows[0]?.gross_profit_per_hour, 18);
  assert.equal(derived.rows[1]?.gross_profit_per_hour, 10);
  const rateColumn = derived.columns.find((column) => column.key === "gross_profit_per_hour");
  assert.equal(rateColumn?.type, "currency");
  assert.deepEqual(derived.provenance.sources.map((source) => source.connector).sort(), ["deputy", "lightspeed"]);
  assert.equal(derived.provenance.coverage?.[0]?.value, 2);
  assert.match(JSON.stringify(derived.provenance.calculations), /Gross profit ÷ Hours worked/u);

  const rank = codexClaimCandidates([derived]).find((candidate) => candidate.assertion === "highest");
  assert.ok(rank, "derived results must support ranked host claims");
  assert.equal(rank.refs[0]?.columnKey, "gross_profit_per_hour");

  const validated = validateCodexFinalAnswer({
    state: "Verified",
    answer: "Blake Sample had the highest Gross profit per worked hour at $18.00.",
    followUps: [],
    presentedResultIds: [derived.resultId],
    claims: [rank],
  }, [salesByEmployee, hoursByEmployee, derived]);
  assert.equal(validated.final.state, "Verified", validated.validationDetail);
});

test("derive_result computes shares, percent-of and null-safe ratios within one result", () => {
  const request = codexDeriveToolInputSchema.parse({
    caption: "Profit mix",
    resultId: salesByEmployee.resultId,
    expressions: [{
      name: "profit_share_pct",
      label: "Share of gross profit",
      operation: "share_of_total_pct",
      leftKey: "sales_analytics.gross_profit",
    }],
  });
  const decision = deriveCodexResult({ request, evidence: [salesByEmployee] });
  assert.ok(decision.ok, JSON.stringify(decision));
  const shares = decision.result.rows.map((row) => Number(row.profit_share_pct));
  assert.equal(Math.round(shares.reduce((total, value) => total + value, 0)), 100);
  assert.equal(decision.result.columns.find((column) => column.key === "profit_share_pct")?.type, "percent");
  assert.equal(shares[0], 43.4783);

  const zeroDenominator: CodexEvidenceResult = {
    ...hoursByEmployee,
    resultId: "01J00000000000000000000203",
    rows: [{ "workforce_analytics.worked_by": "Avery Example", "workforce_analytics.hours_worked": 0 }],
    rowCount: 1,
  };
  const nullSafe = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Rate with zero denominator",
      resultId: salesByEmployee.resultId,
      alignWith: {
        resultId: zeroDenominator.resultId,
        labelKey: "sales_analytics.employees_full_name",
        sourceLabelKey: "workforce_analytics.worked_by",
      },
      expressions: [{
        name: "per_hour",
        label: "Per hour",
        operation: "ratio",
        leftKey: "sales_analytics.gross_profit",
        rightKey: "workforce_analytics.hours_worked",
      }],
    }),
    evidence: [salesByEmployee, zeroDenominator],
  });
  assert.ok(nullSafe.ok);
  assert.equal(nullSafe.result.rows[0]?.per_hour, null);
});

test("derive_result re-projects an existing result without new queries and rejects invalid requests", () => {
  const reprojected = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Bottom performers",
      resultId: salesByEmployee.resultId,
      orderBy: { key: "sales_analytics.gross_profit", direction: "asc" },
      limit: 2,
    }),
    evidence: [salesByEmployee],
  });
  assert.ok(reprojected.ok, JSON.stringify(reprojected));
  assert.equal(reprojected.result.rowCount, 2);
  assert.equal(reprojected.result.rows[0]?.["sales_analytics.gross_profit"], 400);
  assert.ok(codexClaimCandidates([reprojected.result]).some((candidate) => candidate.assertion === "lowest"));

  const unknown = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Unknown source",
      resultId: "01J00000000000000000000999",
      limit: 5,
    }),
    evidence: [salesByEmployee],
  });
  assert.equal(unknown.ok, false);
  assert.equal(!unknown.ok && unknown.error, "unknown_evidence");

  const badKey = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Bad key",
      resultId: salesByEmployee.resultId,
      expressions: [{
        name: "broken",
        label: "Broken",
        operation: "ratio",
        leftKey: "sales_analytics.gross_profit",
        rightKey: "sales_analytics.missing_column",
      }],
    }),
    evidence: [salesByEmployee],
  });
  assert.equal(badKey.ok, false);
  assert.equal(!badKey.ok && badKey.error, "invalid_expression_key");

  assert.throws(() => codexDeriveToolInputSchema.parse({
    caption: "Nothing to do",
    resultId: salesByEmployee.resultId,
  }));
});

test("derive_result groupBy re-aggregates governed rows with trusted sums and date buckets", () => {
  const dailyTakings: CodexEvidenceResult = {
    resultId: "01J00000000000000000000203",
    topic: "Daily takings",
    view: "sales_analytics",
    connector: "lightspeed",
    query: {
      measures: ["sales_analytics.gross_takings"],
      timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "day" }],
      limit: 100,
    },
    queryYaml: "fixture-daily",
    columns: [
      { key: "sales_analytics.completed_at.day", label: "Day", type: "date" },
      { key: "sales_analytics.gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
      { key: "sales_analytics.margin_pct", label: "Margin %", type: "percent" },
    ],
    rows: [
      // 2026-08-03 and 2026-08-10 are Mondays; 2026-08-08 is a Saturday.
      { "sales_analytics.completed_at.day": "2026-08-03T00:00:00.000", "sales_analytics.gross_takings": 100, "sales_analytics.margin_pct": 0.5 },
      { "sales_analytics.completed_at.day": "2026-08-08T00:00:00.000", "sales_analytics.gross_takings": 500, "sales_analytics.margin_pct": 0.4 },
      { "sales_analytics.completed_at.day": "2026-08-10T00:00:00.000", "sales_analytics.gross_takings": 150, "sales_analytics.margin_pct": 0.6 },
    ],
    provenance,
    executionMs: 5,
    rowCount: 3,
  };

  const grouped = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Takings by weekday",
      resultId: dailyTakings.resultId,
      groupBy: { key: "sales_analytics.completed_at.day", bucket: "weekday" },
      orderBy: { key: "sales_analytics.gross_takings", direction: "desc" },
    }),
    evidence: [dailyTakings],
  });
  assert.ok(grouped.ok, JSON.stringify(grouped));
  // Two Mondays collapse into one summed group; Saturday leads the ranking.
  assert.equal(grouped.result.rowCount, 2);
  assert.equal(grouped.result.rows[0]?.["sales_analytics.completed_at.day"], "Saturday");
  assert.equal(grouped.result.rows[0]?.["sales_analytics.gross_takings"], 500);
  assert.equal(grouped.result.rows[1]?.["sales_analytics.completed_at.day"], "Monday");
  assert.equal(grouped.result.rows[1]?.["sales_analytics.gross_takings"], 250);
  // Percent columns cannot be summed and are dropped with a disclosure.
  assert.ok(!grouped.result.columns.some((column) => column.type === "percent"));
  assert.ok(grouped.notes.some((note) => /percent columns/iu.test(note)));
  // Grouped cells are citable evidence like any other derived cells.
  assert.ok(codexClaimCandidates([grouped.result]).some((candidate) => candidate.assertion === "highest"));

  const plainGroup = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Takings by label",
      resultId: salesByEmployee.resultId,
      groupBy: { key: "sales_analytics.employees_full_name" },
    }),
    evidence: [salesByEmployee],
  });
  assert.ok(plainGroup.ok, JSON.stringify(plainGroup));
  assert.equal(plainGroup.ok && plainGroup.result.rowCount, 3);

  const badBucket = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Bucket on names",
      resultId: salesByEmployee.resultId,
      groupBy: { key: "sales_analytics.employees_full_name", bucket: "weekday" },
    }),
    evidence: [salesByEmployee],
  });
  assert.equal(badBucket.ok, false);
  assert.equal(!badBucket.ok && badBucket.error, "invalid_bucket");

  const badKey = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Unknown group key",
      resultId: salesByEmployee.resultId,
      groupBy: { key: "sales_analytics.missing" },
    }),
    evidence: [salesByEmployee],
  });
  assert.equal(badKey.ok, false);
  assert.equal(!badKey.ok && badKey.error, "invalid_group_key");
});

test("externally attributed rule-of-thumb sentences survive grounding; unattributed invented figures do not", () => {
  const evidence = [salesByEmployee];
  const attributed = validateCodexFinalAnswer({
    state: "Verified",
    answer: "**Avery Example leads with $1,000.00 gross profit.** As a general industry rule of thumb, healthy shops run 2 to 4 stock turns a year.",
    followUps: [],
    presentedResultIds: [salesByEmployee.resultId],
    claims: [],
  }, evidence);
  assert.equal(attributed.final.state, "Verified");
  assert.match(attributed.final.answer, /2 to 4 stock turns/u);

  const invented = validateCodexFinalAnswer({
    state: "Verified",
    answer: "**Avery Example leads with $1,000.00 gross profit.** Your shop runs 3.7 stock turns a year.",
    followUps: [],
    presentedResultIds: [salesByEmployee.resultId],
    claims: [],
  }, evidence);
  assert.ok(!/3\.7 stock turns/u.test(invented.final.answer));
});

test("period descriptors ground against governed query time ranges, not result cells", () => {
  // The fixture time range spans 2025-08-01..2026-07-31: 12 months / 365 days.
  const evidence = [salesByEmployee];
  const window = validateCodexFinalAnswer({
    state: "Verified",
    answer: "**Avery Example recorded $1,000.00 gross profit over the last 12 months.**",
    followUps: [],
    presentedResultIds: [salesByEmployee.resultId],
    claims: [],
  }, evidence);
  assert.equal(window.final.state, "Verified");
  assert.match(window.final.answer, /last 12 months/u);

  // A window no governed query covered is still an unsupported figure.
  const invented = validateCodexFinalAnswer({
    state: "Verified",
    answer: "**Avery Example recorded $1,000.00 gross profit over the last 48 weeks.**",
    followUps: [],
    presentedResultIds: [salesByEmployee.resultId],
    claims: [],
  }, evidence);
  assert.ok(!/last 48 weeks/u.test(invented.final.answer));
});

test("derive_result select re-projects columns and duplicate labels are auto-renamed", () => {
  const projected = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Share of gross profit",
      resultId: salesByEmployee.resultId,
      expressions: [
        { name: "gp_share", label: "Staff member", operation: "share_of_total_pct", leftKey: "sales_analytics.gross_profit" },
      ],
      select: ["sales_analytics.employees_full_name", "gp_share"],
    }),
    evidence: [salesByEmployee],
  });
  assert.ok(projected.ok, JSON.stringify(projected));
  // select keeps only the named columns, in order.
  assert.deepEqual(projected.result.columns.map((column) => column.key), ["sales_analytics.employees_full_name", "gp_share"]);
  assert.deepEqual(Object.keys(projected.result.rows[0]!), ["sales_analytics.employees_full_name", "gp_share"]);
  // "Staff member" duplicates the label column's label, so the derived column
  // falls back to its humanized unique name and the rename is disclosed.
  assert.equal(projected.result.columns[1]?.label, "Gp share");
  assert.ok(projected.notes.some((note) => /distinct, descriptive label/u.test(note)));

  const badSelect = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Bad select",
      resultId: salesByEmployee.resultId,
      select: ["sales_analytics.missing_column"],
    }),
    evidence: [salesByEmployee],
  });
  assert.equal(badSelect.ok, false);
  assert.equal(!badSelect.ok && badSelect.error, "invalid_select_key");
});

const scalarTotals: CodexEvidenceResult = {
  resultId: "01J00000000000000000000203",
  topic: "Total sales and transactions",
  view: "sales_analytics",
  connector: "lightspeed",
  query: { measures: ["sales_analytics.gross_takings", "sales_analytics.transactions"] },
  queryYaml: "fixture-scalar-sales",
  columns: [
    { key: "sales_analytics.gross_takings", label: "Gross takings (inc tax)", type: "currency", currency: "AUD" },
    { key: "sales_analytics.transactions", label: "Transactions", type: "number" },
  ],
  rows: [{ "sales_analytics.gross_takings": 94385.03, "sales_analytics.transactions": 688 }],
  provenance,
  executionMs: 5,
  rowCount: 1,
};

const scalarGrossProfit: CodexEvidenceResult = {
  resultId: "01J00000000000000000000204",
  topic: "Gross profit",
  view: "product_sales_analytics",
  connector: "lightspeed",
  query: { measures: ["product_sales_analytics.line_gross_profit"] },
  queryYaml: "fixture-scalar-gp",
  columns: [
    { key: "product_sales_analytics.line_gross_profit", label: "Line gross profit", type: "currency", currency: "AUD" },
  ],
  rows: [{ "product_sales_analytics.line_gross_profit": 50907.5524 }],
  provenance,
  executionMs: 5,
  rowCount: 1,
};

test("label-free alignWith combines two single-row results into one KPI row", () => {
  const request = codexDeriveToolInputSchema.parse({
    caption: "Sales, transactions and gross profit — last 10 weeks",
    resultId: scalarTotals.resultId,
    alignWith: { resultId: scalarGrossProfit.resultId },
    select: [
      "sales_analytics.gross_takings",
      "sales_analytics.transactions",
      "product_sales_analytics.line_gross_profit",
    ],
  });
  const decision = deriveCodexResult({ request, evidence: [scalarTotals, scalarGrossProfit] });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.result.rowCount, 1);
  assert.deepEqual(decision.result.columns.map((column) => column.label), [
    "Gross takings (inc tax)", "Transactions", "Line gross profit",
  ]);
  assert.deepEqual(decision.result.rows[0], {
    "sales_analytics.gross_takings": 94385.03,
    "sales_analytics.transactions": 688,
    "product_sales_analytics.line_gross_profit": 50907.5524,
  });
  assert.ok(decision.notes.some((note) => /side by side/u.test(note)));
});

test("label-free alignWith renames a duplicate column label using the source view", () => {
  const clashing: CodexEvidenceResult = {
    ...scalarGrossProfit,
    resultId: "01J00000000000000000000205",
    columns: [{ key: "product_sales_analytics.line_gross_profit", label: "Transactions", type: "number" }],
  };
  const decision = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Combined totals",
      resultId: scalarTotals.resultId,
      alignWith: { resultId: clashing.resultId },
      limit: 1,
    }),
    evidence: [scalarTotals, clashing],
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.deepEqual(decision.result.columns.map((column) => column.label), [
    "Gross takings (inc tax)", "Transactions", "Transactions — product sales analytics",
  ]);
});

// Monthly figures copied from the failing 2026-08-23 "y/y as a % in columns"
// turn: aligning the same view's same measure across two years used to drop
// the prior-period column silently, leaving only self-ratios of 1.
const monthlyYoYProvenance = (label: string, start: string, end: string) => ({
  ...provenance,
  timeRange: { label, start, end, timezone: "Australia/Melbourne" },
});

const monthKey = "sales_analytics.completed_at.month";

const currentYearMonthly: CodexEvidenceResult = {
  resultId: "01J00000000000000000000301",
  topic: "Current-year monthly sales",
  view: "sales_analytics",
  connector: "lightspeed",
  query: { measures: ["sales_analytics.gross_takings"] },
  queryYaml: "fixture-current-monthly",
  columns: [
    { key: monthKey, label: "Completed at (business date)", type: "datetime" },
    { key: "sales_analytics.gross_takings", label: "Gross takings (inc tax)", type: "currency", currency: "AUD" },
  ],
  rows: [
    { [monthKey]: "2026-01-01T00:00:00.000", "sales_analytics.gross_takings": 49239.12 },
    { [monthKey]: "2026-02-01T00:00:00.000", "sales_analytics.gross_takings": 63188.07 },
    { [monthKey]: "2026-03-01T00:00:00.000", "sales_analytics.gross_takings": 51716.68 },
    { [monthKey]: "2026-04-01T00:00:00.000", "sales_analytics.gross_takings": 51616.29 },
  ],
  provenance: monthlyYoYProvenance("2026-01-01 to 2026-04-30", "2026-01-01", "2026-04-30"),
  executionMs: 5,
  rowCount: 4,
};

const priorYearMonthly: CodexEvidenceResult = {
  ...currentYearMonthly,
  resultId: "01J00000000000000000000302",
  topic: "Prior-year monthly sales",
  queryYaml: "fixture-prior-monthly",
  rows: [
    { [monthKey]: "2025-01-01T00:00:00.000", "sales_analytics.gross_takings": 65098.67 },
    { [monthKey]: "2025-02-01T00:00:00.000", "sales_analytics.gross_takings": 45906.76 },
    { [monthKey]: "2025-03-01T00:00:00.000", "sales_analytics.gross_takings": 42686.15 },
    { [monthKey]: "2025-04-01T00:00:00.000", "sales_analytics.gross_takings": 56775.04 },
  ],
  provenance: monthlyYoYProvenance("2025-01-01 to 2025-04-30", "2025-01-01", "2025-04-30"),
};

test("labelBucket month_of_year aligns the same measure across years and keeps the prior column as __aligned", () => {
  const request = codexDeriveToolInputSchema.parse({
    caption: "Monthly sales with year-on-year change",
    resultId: currentYearMonthly.resultId,
    alignWith: {
      resultId: priorYearMonthly.resultId,
      labelKey: monthKey,
      sourceLabelKey: monthKey,
      labelBucket: "month_of_year",
    },
    expressions: [
      {
        name: "sales_change",
        label: "Change vs prior year",
        operation: "difference",
        leftKey: "sales_analytics.gross_takings",
        rightKey: "sales_analytics.gross_takings__aligned",
      },
      {
        name: "sales_change_pct",
        label: "Change % vs prior year",
        operation: "percent_of",
        leftKey: "sales_change",
        rightKey: "sales_analytics.gross_takings__aligned",
      },
    ],
  });
  const decision = deriveCodexResult({ request, evidence: [currentYearMonthly, priorYearMonthly] });
  assert.ok(decision.ok, JSON.stringify(decision));
  const derived = decision.result;
  assert.equal(derived.rowCount, 4);
  // Rows stay chronological: a bucketed period comparison must not be
  // re-sorted by the first expression.
  assert.deepEqual(derived.rows.map((row) => row[monthKey]), ["January", "February", "March", "April"]);
  const aligned = derived.columns.find((column) => column.key === "sales_analytics.gross_takings__aligned");
  assert.ok(aligned, "the prior-period same-key column must be kept, not dropped");
  // Same view on both sides: the rename tag is the prior period, not the view.
  assert.match(aligned.label, /2025/u);
  const january = derived.rows[0]!;
  assert.equal(january["sales_analytics.gross_takings"], 49239.12);
  assert.equal(january["sales_analytics.gross_takings__aligned"], 65098.67);
  assert.equal(january.sales_change, Number((49239.12 - 65098.67).toFixed(4)));
  assert.equal(january.sales_change_pct, Number(((49239.12 - 65098.67) / 65098.67 * 100).toFixed(4)));
  assert.equal(derived.columns.find((column) => column.key === "sales_change_pct")?.type, "percent");
  assert.equal(derived.provenance.coverage?.[0]?.value, 4);
  assert.ok(decision.notes.some((note) => /calendar month/u.test(note)));
  assert.ok(decision.notes.some((note) => /__aligned/u.test(note)));
  // The disclosed formula names both periods, never "X ÷ X".
  assert.match(JSON.stringify(derived.provenance.calculations), /2025/u);
});

test("pivot transposes a period comparison so months become columns", () => {
  const alignRequest = codexDeriveToolInputSchema.parse({
    caption: "Monthly sales with year-on-year change",
    resultId: currentYearMonthly.resultId,
    alignWith: {
      resultId: priorYearMonthly.resultId,
      labelKey: monthKey,
      sourceLabelKey: monthKey,
      labelBucket: "month_of_year",
    },
    expressions: [{
      name: "sales_change_pct",
      label: "Change % vs prior year",
      operation: "percent_of",
      leftKey: "sales_analytics.gross_takings",
      rightKey: "sales_analytics.gross_takings__aligned",
    }],
  });
  const alignedDecision = deriveCodexResult({ request: alignRequest, evidence: [currentYearMonthly, priorYearMonthly] });
  assert.ok(alignedDecision.ok, JSON.stringify(alignedDecision));
  const alignedResult = alignedDecision.result;

  const pivotDecision = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Monthly sales year on year, months across the top",
      resultId: alignedResult.resultId,
      pivot: {
        labelKey: monthKey,
        valueKeys: [
          "sales_analytics.gross_takings",
          "sales_analytics.gross_takings__aligned",
          "sales_change_pct",
        ],
      },
    }),
    evidence: [currentYearMonthly, priorYearMonthly, alignedResult],
  });
  assert.ok(pivotDecision.ok, JSON.stringify(pivotDecision));
  const pivoted = pivotDecision.result;
  assert.deepEqual(pivoted.columns.map((column) => column.key), ["metric", "january", "february", "march", "april"]);
  // Generated keys must satisfy the claim columnKey grammar so pivoted cells stay citable.
  for (const column of pivoted.columns) assert.match(column.key, /^[a-z_][a-z0-9_.]{0,119}$/u);
  assert.equal(pivoted.rowCount, 3);
  assert.equal(pivoted.rows[0]?.metric, "Gross takings (inc tax)");
  assert.equal(pivoted.rows[0]?.january, 49239.12);
  assert.equal(pivoted.rows[1]?.january, 65098.67);
  assert.equal(pivoted.rows[2]?.january, Number(((49239.12 / 65098.67) * 100).toFixed(4)));
  // Currency and percent rows share columns, so the pivoted columns fall back to plain numbers…
  assert.equal(pivoted.columns[1]?.type, "number");
  // …but every metric row keeps its own unit so renderers still show $ and %.
  assert.deepEqual(pivoted.rowFormats, [
    { type: "currency", currency: "AUD" },
    { type: "currency", currency: "AUD" },
    { type: "percent" },
  ]);
  assert.ok(pivotDecision.notes.some((note) => /unit format/u.test(note)));
  assert.ok(pivotDecision.notes.some((note) => /[Pp]ivoted/u.test(note)));

  // A single-unit pivot keeps the shared column type and needs no row formats.
  const uniformDecision = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Monthly sales only, months across the top",
      resultId: alignedResult.resultId,
      pivot: {
        labelKey: monthKey,
        valueKeys: ["sales_analytics.gross_takings", "sales_analytics.gross_takings__aligned"],
      },
    }),
    evidence: [currentYearMonthly, priorYearMonthly, alignedResult],
  });
  assert.ok(uniformDecision.ok, JSON.stringify(uniformDecision));
  assert.equal(uniformDecision.result.columns[1]?.type, "currency");
  assert.equal(uniformDecision.result.columns[1]?.currency, "AUD");
  assert.equal(uniformDecision.result.rowFormats, undefined);
});

test("pivot refuses ambiguous or oversized label sets", () => {
  const duplicated: CodexEvidenceResult = {
    ...currentYearMonthly,
    resultId: "01J00000000000000000000303",
    rows: [
      { [monthKey]: "2026-01-01T00:00:00.000", "sales_analytics.gross_takings": 10 },
      { [monthKey]: "2026-01-01T00:00:00.000", "sales_analytics.gross_takings": 20 },
    ],
    rowCount: 2,
  };
  const ambiguous = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Ambiguous pivot",
      resultId: duplicated.resultId,
      pivot: { labelKey: monthKey },
    }),
    evidence: [duplicated],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(!ambiguous.ok && ambiguous.error, "duplicate_pivot_label");

  const wide: CodexEvidenceResult = {
    ...currentYearMonthly,
    resultId: "01J00000000000000000000304",
    rows: Array.from({ length: 14 }, (_, index) => ({
      [monthKey]: `${2013 + index}-01-01T00:00:00.000`,
      "sales_analytics.gross_takings": index + 1,
    })),
    rowCount: 14,
  };
  const oversized = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Too wide",
      resultId: wide.resultId,
      pivot: { labelKey: monthKey },
    }),
    evidence: [wide],
  });
  assert.equal(oversized.ok, false);
  assert.equal(!oversized.ok && oversized.error, "too_many_pivot_columns");
});

test("label-free same-key combine keeps both periods so a YoY ratio is not a self-ratio", () => {
  const januaryCurrent: CodexEvidenceResult = {
    ...scalarTotals,
    resultId: "01J00000000000000000000305",
    topic: "January current-year sales",
    columns: [{ key: "sales_analytics.gross_takings", label: "Gross takings (inc tax)", type: "currency", currency: "AUD" }],
    rows: [{ "sales_analytics.gross_takings": 49239.12 }],
    provenance: monthlyYoYProvenance("2026-01-01 to 2026-01-31", "2026-01-01", "2026-01-31"),
  };
  const januaryPrior: CodexEvidenceResult = {
    ...januaryCurrent,
    resultId: "01J00000000000000000000306",
    topic: "January prior-year sales",
    rows: [{ "sales_analytics.gross_takings": 65098.67 }],
    provenance: monthlyYoYProvenance("2025-01-01 to 2025-01-31", "2025-01-01", "2025-01-31"),
  };
  const decision = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "January sales versus prior year",
      resultId: januaryCurrent.resultId,
      alignWith: { resultId: januaryPrior.resultId },
      expressions: [{
        name: "yoy_ratio",
        label: "Sales versus prior January",
        operation: "ratio",
        leftKey: "sales_analytics.gross_takings",
        rightKey: "sales_analytics.gross_takings__aligned",
      }],
    }),
    evidence: [januaryCurrent, januaryPrior],
  });
  assert.ok(decision.ok, JSON.stringify(decision));
  const row = decision.result.rows[0]!;
  assert.equal(row["sales_analytics.gross_takings"], 49239.12);
  assert.equal(row["sales_analytics.gross_takings__aligned"], 65098.67);
  assert.equal(row.yoy_ratio, Number((49239.12 / 65098.67).toFixed(4)));
  const alignedColumn = decision.result.columns.find((column) => column.key === "sales_analytics.gross_takings__aligned");
  assert.match(alignedColumn?.label ?? "", /2025/u);
});

test("label-free alignWith refuses multi-row results and half-specified label keys", () => {
  const multiRow = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Bad combine",
      resultId: salesByEmployee.resultId,
      alignWith: { resultId: scalarGrossProfit.resultId },
      limit: 5,
    }),
    evidence: [salesByEmployee, scalarGrossProfit],
  });
  assert.equal(multiRow.ok, false);
  assert.equal(!multiRow.ok && multiRow.error, "not_single_row");
  const half = codexDeriveToolInputSchema.safeParse({
    caption: "Half-specified alignment",
    resultId: scalarTotals.resultId,
    alignWith: { resultId: scalarGrossProfit.resultId, labelKey: "sales_analytics.transactions" },
    limit: 1,
  });
  assert.equal(half.success, false);
});

// A per-month run-rate is the natural unit when the owner names a "$X per
// month" target; aggregate:"average" makes it derivable (and citable) instead
// of impossible.
test("derive_result groupBy aggregate average produces a citable per-period run-rate", () => {
  const monthlySubscriptions: CodexEvidenceResult = {
    resultId: "01J00000000000000000000204",
    topic: "Monthly subscriptions",
    view: "xero_profit_and_loss_account_analytics",
    connector: "xero",
    query: {
      measures: ["xero_profit_and_loss_account_analytics.operating_expenses"],
      timeDimensions: [{ dimension: "xero_profit_and_loss_account_analytics.period_start", granularity: "month" }],
      limit: 100,
    },
    queryYaml: "fixture-monthly-subscriptions",
    columns: [
      { key: "xero_profit_and_loss_account_analytics.period_start.month", label: "Month", type: "date" },
      { key: "xero_profit_and_loss_account_analytics.operating_expenses", label: "Subscriptions", type: "currency", currency: "AUD" },
    ],
    rows: [
      { "xero_profit_and_loss_account_analytics.period_start.month": "2026-01-01T00:00:00.000", "xero_profit_and_loss_account_analytics.operating_expenses": 100 },
      { "xero_profit_and_loss_account_analytics.period_start.month": "2026-02-01T00:00:00.000", "xero_profit_and_loss_account_analytics.operating_expenses": 200 },
      { "xero_profit_and_loss_account_analytics.period_start.month": "2026-03-01T00:00:00.000", "xero_profit_and_loss_account_analytics.operating_expenses": 600 },
    ],
    provenance,
    executionMs: 5,
    rowCount: 3,
  };

  const averaged = deriveCodexResult({
    request: codexDeriveToolInputSchema.parse({
      caption: "Average monthly subscriptions",
      resultId: monthlySubscriptions.resultId,
      groupBy: { key: "xero_profit_and_loss_account_analytics.period_start.month", bucket: "year", aggregate: "average" },
    }),
    evidence: [monthlySubscriptions],
  });
  assert.ok(averaged.ok, JSON.stringify(averaged));
  assert.equal(averaged.result.rowCount, 1);
  assert.equal(averaged.result.rows[0]?.["xero_profit_and_loss_account_analytics.operating_expenses"], 300);
  // The averaged column is labelled as an average, and the note discloses it.
  const label = averaged.result.columns.find((column) => column.key === "xero_profit_and_loss_account_analytics.operating_expenses")?.label;
  assert.equal(label, "Subscriptions (average)");
  assert.match(averaged.notes.join(" "), /averages/u);
  // The derived cell grounds a "$300 a month" statement in the answer.
  const validated = validateCodexFinalAnswer({
    state: "Qualified",
    keyInsights: [],
    answer: "Subscriptions averaged $300 a month this year.",
    followUps: [],
    presentedResultIds: [averaged.result.resultId],
    claims: [],
  }, [monthlySubscriptions, averaged.result]);
  assert.equal(validated.final.state, "Qualified");
  assert.match(validated.final.answer, /\$300/u);
});
