import { FIXTURE_LIGHTSPEED_CONNECTION_ID } from "../fixtures/source.js";

export type GoldenRoute =
  | "semantic"
  | "source_exploration"
  | "clarification"
  | "unavailable";

export type GoldenState =
  | "verified"
  | "qualified"
  | "exploratory"
  | "clarification"
  | "unavailable";

export type GoldenQuestion = Readonly<{
  id: string;
  question: string;
  expectedRoute: GoldenRoute;
  expectedState: GoldenState;
  /** Typed semantic IR. Omitted only where the current governed model cannot execute the seed yet. */
  ir?: unknown;
  /** Explicit comparison IR for periods the v1 IR cannot express as a built-in comparison. */
  comparisonIr?: unknown;
  sourceQuery?: unknown;
  expectedRows?: readonly Readonly<Record<string, string>>[];
  expectedComparisonRows?: readonly Readonly<Record<string, string>>[];
  rationale?: string;
}>;

const monthToDate = {
  type: "absolute",
  from: "2026-03-01T00:00:00.000Z",
  to: "2026-03-16T00:00:00.000Z",
} as const;
const lastMonth = {
  type: "absolute",
  from: "2026-02-01T00:00:00.000Z",
  to: "2026-03-01T00:00:00.000Z",
} as const;
const quarterToDate = {
  type: "absolute",
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-03-16T00:00:00.000Z",
} as const;
const priorQuarterLikeForLike = {
  type: "absolute",
  from: "2025-10-01T00:00:00.000Z",
  to: "2025-12-16T00:00:00.000Z",
} as const;
const currentSnapshotWindow = {
  type: "absolute",
  from: "2026-02-14T00:00:00.000Z",
  to: "2026-03-16T00:00:00.000Z",
} as const;
const fixtureLastWeek = {
  type: "absolute",
  from: "2026-03-01T00:00:00.000Z",
  to: "2026-03-08T00:00:00.000Z",
} as const;
const deadStockWindow = {
  type: "absolute",
  from: "2025-12-16T00:00:00.000Z",
  to: "2026-03-16T00:00:00.000Z",
} as const;
const fixtureYesterday = {
  type: "absolute",
  from: "2026-03-01T00:00:00.000Z",
  to: "2026-03-02T00:00:00.000Z",
} as const;
const fixtureTuesday = {
  type: "absolute",
  from: "2026-02-10T00:00:00.000Z",
  to: "2026-02-11T00:00:00.000Z",
} as const;

export const seedGoldenQuestions: readonly GoldenQuestion[] = [
  {
    id: "sales-month-vs-last",
    question: "Net sales this month versus last, like for like on the partial month.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: [],
      filters: [],
      time: {
        field: "business_date",
        range: monthToDate,
        compare: "same_period_prior_month",
      },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ net_sales_ex_gst: "210.0000" }],
    expectedComparisonRows: [{ net_sales_ex_gst: "150.0000" }],
  },
  {
    id: "sales-category",
    question: "Which categories are performing well this month?",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "sales_performance",
      metrics: ["net_sales_ex_gst"],
      dimensions: ["product.category"],
      filters: [],
      time: { field: "business_date", range: monthToDate, compare: "none" },
      sort: [{ metric: "net_sales_ex_gst", dir: "desc" }],
      limit: 20,
      parameters: { category_mode: "as_currently_classified" },
    },
    expectedRows: [
      { "product.category": "Coffee", net_sales_ex_gst: "160.0000" },
      { "product.category": "Food", net_sales_ex_gst: "50.0000" },
    ],
  },
  {
    id: "sales-products-margin",
    question: "Top ten products by gross margin this quarter.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      topic: "sales_performance",
      metrics: ["gross_margin"],
      dimensions: ["product.variant"],
      filters: [],
      time: { field: "business_date", range: quarterToDate, compare: "none" },
      sort: [{ metric: "gross_margin", dir: "desc" }],
      limit: 10,
      parameters: {},
    },
    expectedRows: [
      { "product.variant": "House beans", gross_margin: "138.0000" },
      { "product.variant": "Cold brew", gross_margin: "48.0000" },
      { "product.variant": "Banana bread", gross_margin: "30.0000" },
    ],
    rationale: "Qualified because product-level POS cost coverage must be disclosed.",
  },
  {
    id: "sales-aov-trend",
    question: "Average order value trend over six months.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "sales_performance",
      metrics: ["avg_order_value"],
      dimensions: ["business_date"],
      filters: [],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2025-09-15T00:00:00.000Z",
          to: "2026-03-16T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [],
      limit: 200,
      parameters: {},
    },
    expectedRows: [
      { business_date: "2026-02-10", avg_order_value: "165.0000" },
      { business_date: "2026-03-01", avg_order_value: "82.5000" },
      { business_date: "2026-03-02", avg_order_value: "66.0000" },
    ],
    rationale: "The fixture uses daily points; production presentation may roll them into calendar months.",
  },
  {
    id: "sales-discount-location",
    question: "Discount rate by location last month.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "sales_performance",
      metrics: ["discount_rate"],
      dimensions: ["location"],
      filters: [],
      time: { field: "business_date", range: lastMonth, compare: "none" },
      sort: [{ metric: "discount_rate", dir: "desc" }],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ location: "Carlton", discount_rate: "0.0000" }],
  },
  {
    id: "sales-refund-rate",
    question: "Refund rate this quarter versus last.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "sales_performance",
      metrics: ["refund_rate"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: quarterToDate, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    comparisonIr: {
      topic: "sales_performance",
      metrics: ["refund_rate"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: priorQuarterLikeForLike, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ refund_rate: "5.2632" }],
    expectedComparisonRows: [{ refund_rate: "0.0000" }],
  },
  {
    id: "inventory-overstocked",
    question: "Which categories are overstocked by stock cover?",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "inventory_health",
      metrics: ["stock_cover_days"],
      dimensions: ["product.category"],
      filters: [],
      time: { field: "snapshot_date", range: currentSnapshotWindow, compare: "none" },
      sort: [{ metric: "stock_cover_days", dir: "desc" }],
      limit: 2,
      // Tenant windows are trusted overlay inputs, never model-authored IR.
      parameters: {},
    },
    expectedRows: [
      { "product.category": "Coffee", stock_cover_days: "25.0000" },
      { "product.category": "Food", stock_cover_days: "4.0000" },
    ],
  },
  {
    id: "inventory-sell-through",
    question: "Sell-through over the last 30 days.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "inventory_health",
      metrics: ["sell_through_rate"],
      dimensions: [],
      filters: [],
      time: { field: "snapshot_date", range: currentSnapshotWindow, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ sell_through_rate: "7.9755" }],
  },
  {
    id: "inventory-out",
    question: "What is out of stock right now?",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "inventory_health",
      metrics: ["stock_on_hand_units"],
      dimensions: ["product.variant"],
      filters: [],
      time: { field: "snapshot_date", range: currentSnapshotWindow, compare: "none" },
      sort: [{ metric: "stock_on_hand_units", dir: "asc" }],
      limit: 1,
      parameters: {},
    },
    expectedRows: [{ "product.variant": "Cold brew", stock_on_hand_units: "0.0000" }],
  },
  {
    id: "inventory-dead",
    question: "Show dead stock with no sales in 90 days.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      topic: "inventory_health",
      metrics: ["sell_through_rate", "stock_on_hand_units"],
      dimensions: ["product.variant"],
      filters: [],
      time: { field: "business_date", range: deadStockWindow, compare: "none" },
      sort: [
        { metric: "sell_through_rate", dir: "asc" },
        { metric: "stock_on_hand_units", dir: "desc" },
      ],
      limit: 1,
      parameters: {},
    },
    expectedRows: [{
      "product.variant": "Old filter papers",
      sell_through_rate: "0.0000",
      stock_on_hand_units: "30.0000",
    }],
    rationale: "Qualified because the zero-sale classification depends on complete 90-day movement and sales coverage.",
  },
  {
    id: "customers-new-returning",
    question: "New versus returning customers this month.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      topic: "customers_retention",
      metrics: ["new_customers", "returning_customer_rate"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: monthToDate, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ new_customers: "2.0000", returning_customer_rate: "50.0000" }],
    rationale: "First-observed and returning classifications are bounded by identified-customer and history coverage.",
  },
  {
    id: "customers-lapsed",
    question: "Customers lapsed in the last six months.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      topic: "customers_retention",
      metrics: ["lapsed_customers"],
      dimensions: [],
      filters: [],
      time: {
        field: "last_order_at",
        range: {
          type: "absolute",
          from: "2025-01-01T00:00:00.000Z",
          to: "2026-03-16T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ lapsed_customers: "1.0000" }],
    rationale: "Qualified because the approved 180-day as-of window and complete source history must be disclosed.",
  },
  {
    id: "customers-repeat",
    question: "Repeat purchase rate this year.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      topic: "customers_retention",
      metrics: ["repeat_purchase_rate"],
      dimensions: [],
      filters: [],
      time: {
        field: "business_date",
        range: {
          type: "absolute",
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-03-16T00:00:00.000Z",
        },
        compare: "none",
      },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ repeat_purchase_rate: "50.0000" }],
    rationale: "Only identified customers contribute to the denominator.",
  },
  {
    id: "workforce-best",
    question: "Which employees working today performed best over six months?",
    expectedRoute: "clarification",
    expectedState: "clarification",
    rationale: "Best materially differs between sales, gross margin and sales per worked hour.",
  },
  {
    id: "workforce-roster-vs-worked",
    question: "Rostered versus worked hours last week by location.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "workforce_labour",
      metrics: ["rostered_hours", "worked_hours"],
      dimensions: ["location"],
      filters: [],
      time: { field: "business_date", range: fixtureLastWeek, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [
      { location: "Carlton", rostered_hours: "16.0000", worked_hours: "15.0000" },
      { location: "Fitzroy", rostered_hours: "8.0000", worked_hours: "8.0000" },
    ],
  },
  {
    id: "workforce-labour-percent",
    question: "Labour cost as a percentage of sales by week this quarter.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      kind: "composite",
      topic: "workforce_sales",
      metrics: ["labour_cost_pct_of_sales"],
      queries: [
        {
          topic: "sales_performance",
          metrics: ["net_sales_ex_gst"],
          dimensions: ["calendar_week"],
          filters: [],
          time: { field: "business_date", range: quarterToDate, compare: "none" },
          parameters: {},
        },
        {
          topic: "workforce_labour",
          metrics: ["labour_cost"],
          dimensions: ["calendar_week"],
          filters: [],
          time: { field: "business_date", range: quarterToDate, compare: "none" },
          parameters: {},
        },
      ],
      alignOn: ["calendar_week"],
      sort: [{ metric: "labour_cost_pct_of_sales", dir: "desc" }],
      limit: 20,
      parameters: {},
    },
    expectedRows: [
      {
        calendar_week: "2026-03-02",
        net_sales_ex_gst: "60.0000",
        labour_cost: "240.0000",
        labour_cost_pct_of_sales: "400.0000",
      },
      {
        calendar_week: "2026-02-23",
        net_sales_ex_gst: "150.0000",
        labour_cost: "450.0000",
        labour_cost_pct_of_sales: "300.0000",
      },
      {
        calendar_week: "2026-02-09",
        net_sales_ex_gst: "150.0000",
        labour_cost: "0.0000",
        labour_cost_pct_of_sales: "0.0000",
      },
    ],
    rationale: "Qualified because the labour-cost coverage check must be disclosed.",
  },
  {
    id: "workforce-overtime",
    question: "Overtime hours last fortnight.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "workforce_labour",
      metrics: ["overtime_hours"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: monthToDate, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ overtime_hours: "2.0000" }],
  },
  {
    id: "workforce-sales-hour",
    question: "Sales per worked hour by location.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      kind: "composite",
      topic: "workforce_sales",
      metrics: ["sales_per_labour_hour"],
      queries: [
        {
          topic: "sales_performance",
          metrics: ["net_sales_ex_gst"],
          dimensions: ["location"],
          filters: [],
          time: { field: "business_date", range: monthToDate, compare: "none" },
          parameters: {},
        },
        {
          topic: "workforce_labour",
          metrics: ["worked_hours"],
          dimensions: ["location"],
          filters: [],
          time: { field: "business_date", range: monthToDate, compare: "none" },
          parameters: {},
        },
      ],
      alignOn: ["location"],
      sort: [{ metric: "sales_per_labour_hour", dir: "desc" }],
      limit: 20,
      parameters: {},
    },
    expectedRows: [
      {
        location: "Fitzroy",
        net_sales_ex_gst: "80.0000",
        worked_hours: "8.0000",
        sales_per_labour_hour: "10.0000",
      },
      {
        location: "Carlton",
        net_sales_ex_gst: "130.0000",
        worked_hours: "15.0000",
        sales_per_labour_hour: "8.6667",
      },
    ],
  },
  {
    id: "finance-gst",
    question: "GST collected this quarter.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "profitability_cash",
      metrics: ["gst_collected"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: quarterToDate, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ gst_collected: "21.0000" }],
  },
  {
    id: "finance-receivables",
    question: "Receivables outstanding right now.",
    expectedRoute: "semantic",
    expectedState: "verified",
    ir: {
      topic: "profitability_cash",
      metrics: ["receivables_outstanding"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: monthToDate, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{ receivables_outstanding: "450.0000" }],
  },
  {
    id: "finance-profit",
    question: "What was profit last month?",
    expectedRoute: "clarification",
    expectedState: "clarification",
    rationale: "Operational gross margin and accounting net profit materially differ.",
  },
  {
    id: "finance-cash-pos",
    question: "Cash receipts versus POS takings yesterday.",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      kind: "composite",
      topic: "reconciliation",
      metrics: ["pos_to_ledger_variance"],
      queries: [
        {
          topic: "sales_performance",
          metrics: ["gross_takings_inc_gst", "net_sales_ex_gst"],
          dimensions: ["business_date", "location"],
          filters: [],
          time: { field: "business_date", range: fixtureYesterday, compare: "none" },
          parameters: {},
        },
        {
          topic: "profitability_cash",
          metrics: ["cash_receipts", "accrued_revenue"],
          dimensions: ["business_date", "location"],
          filters: [],
          time: { field: "business_date", range: fixtureYesterday, compare: "none" },
          parameters: {},
        },
      ],
      alignOn: ["business_date", "location"],
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{
      business_date: "2026-03-01",
      location: "Carlton",
      gross_takings_inc_gst: "165.0000",
      cash_receipts: "165.0000",
    }],
    rationale: "The one-day window is intentionally Qualified; fixture receipt date and operational business date are explicitly aligned.",
  },
  {
    id: "reconcile-bank",
    question: "Did Tuesday's takings reach the bank?",
    expectedRoute: "semantic",
    expectedState: "qualified",
    ir: {
      kind: "composite",
      topic: "reconciliation",
      metrics: ["pos_to_ledger_variance"],
      queries: [
        {
          topic: "sales_performance",
          metrics: ["gross_takings_inc_gst", "net_sales_ex_gst"],
          dimensions: ["business_date", "location"],
          filters: [],
          time: { field: "business_date", range: fixtureTuesday, compare: "none" },
          parameters: {},
        },
        {
          topic: "profitability_cash",
          metrics: ["cash_receipts", "accrued_revenue"],
          dimensions: ["business_date", "location"],
          filters: [],
          time: { field: "business_date", range: fixtureTuesday, compare: "none" },
          parameters: {},
        },
      ],
      alignOn: ["business_date", "location"],
      sort: [],
      limit: 20,
      parameters: {},
    },
    expectedRows: [{
      business_date: "2026-02-10",
      location: "Carlton",
      gross_takings_inc_gst: "165.0000",
      cash_receipts: "150.0000",
    }],
    rationale: "Qualified: the fixture shows a $15 shortfall and the settlement/posting bridge coverage must be surfaced.",
  },
  {
    id: "honesty-footfall",
    question: "Why did foot traffic decline?",
    expectedRoute: "unavailable",
    expectedState: "unavailable",
    rationale: "No foot-traffic source or governed metric is connected.",
  },
  {
    id: "exploration-staff-discount",
    question: "How many sales used the discount reason staff purchase?",
    expectedRoute: "source_exploration",
    expectedState: "exploratory",
    sourceQuery: {
      connectionId: FIXTURE_LIGHTSPEED_CONNECTION_ID,
      sourceTable: "sales",
      fields: [],
      aggregates: [{ op: "count", as: "matching_sales" }],
      groupBy: [],
      filters: [{ field: "discount_reason", op: "eq", values: ["staff purchase"] }],
      limit: 20,
      authorityConcept: "operational_sales",
      requestedMetricConcept: "staff_discount_usage",
    },
    expectedRows: [{ matching_sales: "2" }],
    rationale: "This is the governed source-exploration example in section 15 and supplies the otherwise implicit twenty-fifth seed case.",
  },
] as const;
