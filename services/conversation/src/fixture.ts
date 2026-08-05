import {
  assertOrderedSanitizedTrace,
  sanitizeTraceText,
  type TraceEvent,
  type TraceProvenance,
} from "../../../packages/shared/src/index.js";

export const FIXTURE_RESULT_ID = "result_fixture_category_sales_2026_07";

export const FIXTURE_PROVENANCE: TraceProvenance = Object.freeze({
  sources: Object.freeze([
    Object.freeze({
      connector: "lightspeed" as const,
      label: "Lightspeed Retail R-Series sales",
      dataThrough: "2026-08-03T00:42:00.000Z",
    }),
  ]),
  timeRange: Object.freeze({
    label: "July 2026",
    start: "2026-07-01T00:00:00+10:00",
    end: "2026-07-31T23:59:59+10:00",
    timezone: "Australia/Melbourne",
  }),
  definitions: Object.freeze([
    Object.freeze({
      metric: "commerce.net_sales_ex_gst",
      label: "Net sales",
      definition:
        "Completed order-line sales excluding GST, less refunds on the day they occur.",
    }),
    Object.freeze({
      metric: "commerce.gross_margin_pct",
      label: "Gross margin",
      definition: "Gross margin divided by net sales excluding GST.",
    }),
  ]),
  semanticBundleHash: "sha256:fixture-albert-v1-category-sales-2026-07",
  identityGraph: Object.freeze({ version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" }),
  coverage: Object.freeze([
    Object.freeze({
      label: "Category assignment coverage",
      value: 98.7,
      unit: "percent" as const,
    }),
  ]),
});

const fixtureTrace: readonly TraceEvent[] = Object.freeze([
  Object.freeze({
    id: "trace_fixture_001",
    sequence: 1,
    type: "progress" as const,
    status: "running" as const,
    occurredAt: "2026-08-03T00:43:00.000Z",
    stage: "planning" as const,
    label: "Planning the governed analysis",
    detail: "Matching the question to governed Topics, then checking source capabilities and data health before querying",
    progress: 0.08,
  }),
  Object.freeze({
    id: "trace_fixture_002",
    sequence: 2,
    type: "progress" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.080Z",
    stage: "catalogue" as const,
    label: "Matched 1 governed Topic",
    detail: "Sales performance",
    progress: 0.2,
  }),
  Object.freeze({
    id: "trace_fixture_003",
    sequence: 3,
    type: "progress" as const,
    status: "running" as const,
    occurredAt: "2026-08-03T00:43:00.160Z",
    stage: "query" as const,
    label: "Querying sales performance",
    detail: "net sales ex GST, gross margin % · by category · 1 Jul 2026 – 31 Jul 2026",
    progress: 0.45,
  }),
  Object.freeze({
    id: "trace_fixture_004",
    sequence: 4,
    type: "query" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.240Z",
    topic: "sales_performance",
    metrics: Object.freeze([
      "commerce.net_sales_ex_gst",
      "commerce.gross_margin_pct",
    ]),
    dimensions: Object.freeze(["product.category"]),
    timeRange: FIXTURE_PROVENANCE.timeRange,
    lens: "Categories as currently classified",
  }),
  Object.freeze({
    id: "trace_fixture_005",
    sequence: 5,
    type: "table" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.400Z",
    caption: "Category performance · July 2026",
    columns: Object.freeze([
      Object.freeze({ key: "category", label: "Category", type: "string" as const }),
      Object.freeze({ key: "netSales", label: "Net sales", type: "currency" as const, currency: "AUD" }),
      Object.freeze({ key: "grossMarginPct", label: "Gross margin", type: "percent" as const }),
    ]),
    rows: Object.freeze([
      Object.freeze({ category: "Bikes", netSales: 84240, grossMarginPct: 38.4 }),
      Object.freeze({ category: "Accessories", netSales: 51780, grossMarginPct: 52.1 }),
      Object.freeze({ category: "Workshop", netSales: 31640, grossMarginPct: 61.7 }),
      Object.freeze({ category: "Apparel", netSales: 22490, grossMarginPct: 46.9 }),
    ]),
    resultId: FIXTURE_RESULT_ID,
    provenance: FIXTURE_PROVENANCE,
  }),
  Object.freeze({
    id: "trace_fixture_006",
    sequence: 6,
    type: "chart" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.460Z",
    caption: "Net sales by category",
    chartType: "bar" as const,
    dataRef: FIXTURE_RESULT_ID,
    xKey: "category",
    yKey: "netSales",
  }),
  Object.freeze({
    id: "trace_fixture_007",
    sequence: 7,
    type: "validation" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.520Z",
    name: "golden_fixture_match",
    outcome: "passed" as const,
    detail: "Totals, refund treatment, freshness, and category coverage passed.",
  }),
  Object.freeze({
    id: "trace_fixture_008",
    sequence: 8,
    type: "narrative" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.600Z",
    text: "Preparing the answer with definitions and freshness attached.",
  }),
  Object.freeze({
    id: "trace_fixture_009",
    sequence: 9,
    type: "answer" as const,
    status: "complete" as const,
    occurredAt: "2026-08-03T00:43:00.720Z",
    state: "Verified" as const,
    text: sanitizeTraceText(
      "Bikes led net sales in July, while Workshop delivered the strongest gross margin percentage.",
    ),
    provenance: FIXTURE_PROVENANCE,
    followUps: Object.freeze([
      "Compare these categories with June",
      "Show the products driving Workshop margin",
    ]),
  }),
]);

/** Returns a deterministic, validated fixture suitable for UI and transport tests. */
export function createDeterministicFixtureTrace(): readonly TraceEvent[] {
  assertOrderedSanitizedTrace(fixtureTrace);
  return fixtureTrace;
}
