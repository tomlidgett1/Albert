/**
 * Client-safe and workerd-safe. The Vinext worker cannot load Vega, so this
 * file must never import flint-chart, vega, vega-lite, or vega-interpreter.
 */
export const FLINT_CHART_TYPES = [
  "Scatter Plot",
  "Regression",
  "Connected Scatter Plot",
  "Ranged Dot Plot",
  "Strip Plot",
  "Bar Chart",
  "Grouped Bar Chart",
  "Stacked Bar Chart",
  "Pyramid Chart",
  "Lollipop Chart",
  "Waterfall Chart",
  "Gantt Chart",
  "Bullet Chart",
  "Histogram",
  "Boxplot",
  "ECDF Plot",
  "Heatmap",
  "Calendar Heatmap",
  "Line Chart",
  "Sparkline",
  "Bump Chart",
  "Slope Chart",
  "Area Chart",
  "Range Area Chart",
  "Violin Plot",
  "Streamgraph",
  "Density Plot",
  "Pie Chart",
  "Rose Chart",
  "Radar Chart",
  "Candlestick Chart",
  "Bar Table",
  "KPI Card",
  "Map",
  "Choropleth",
] as const;

export type FlintChartType = (typeof FLINT_CHART_TYPES)[number];
export type TestChartAppearance = "light" | "dark";
export type TestChartSource = "luna" | "fallback";
export type TestChartVerdict = "pass" | "miss" | "open";

export const FLINT_SEMANTIC_TYPES = [
  "DateTime", "Date", "Time", "Timestamp",
  "Year", "Quarter", "Month", "Week", "Day", "Hour", "YearMonth", "YearQuarter", "YearWeek", "Decade",
  "Duration",
  "Amount", "Price", "Quantity", "Count", "Number",
  "Percentage",
  "Profit", "PercentageChange", "Sentiment", "Correlation",
  "Temperature",
  "Rank", "Score", "ID",
  "Latitude", "Longitude",
  "Country", "State", "City", "Region", "Address", "ZipCode",
  "Category", "Name", "Status", "Boolean", "Direction", "Range",
  "Unknown",
] as const;

export type FlintSemanticType = (typeof FLINT_SEMANTIC_TYPES)[number];

const REQUIRED_CHANNELS: Readonly<Partial<Record<FlintChartType, readonly string[]>>> = {
  "Scatter Plot": ["x", "y"],
  "Regression": ["x", "y"],
  "Connected Scatter Plot": ["x", "y"],
  "Ranged Dot Plot": ["x", "y"],
  "Strip Plot": ["x", "y"],
  "Bar Chart": ["x", "y"],
  "Grouped Bar Chart": ["x", "y", "group"],
  "Stacked Bar Chart": ["x", "y", "color"],
  "Pyramid Chart": ["x", "y", "color"],
  "Lollipop Chart": ["x", "y"],
  "Waterfall Chart": ["x", "y"],
  "Gantt Chart": ["y", "x", "x2"],
  "Bullet Chart": ["y", "x", "goal"],
  "Histogram": ["x"],
  "Boxplot": ["x", "y"],
  "ECDF Plot": ["x"],
  "Heatmap": ["x", "y", "color"],
  "Calendar Heatmap": ["x", "color"],
  "Line Chart": ["x", "y"],
  "Sparkline": ["x", "y"],
  "Bump Chart": ["x", "y", "color"],
  "Slope Chart": ["x", "y", "color"],
  "Area Chart": ["x", "y"],
  "Range Area Chart": ["x", "y", "y2"],
  "Violin Plot": ["x", "y"],
  "Streamgraph": ["x", "y", "color"],
  "Density Plot": ["x"],
  "Pie Chart": ["size", "color"],
  "Rose Chart": ["x", "y"],
  "Radar Chart": ["x", "y"],
  "Candlestick Chart": ["x", "open", "high", "low", "close"],
  "Bar Table": ["y", "x"],
  "KPI Card": ["metric", "value"],
  "Map": ["longitude", "latitude"],
  "Choropleth": ["id", "color"],
};

export type FlintSemanticAnnotation = Readonly<{
  semanticType: FlintSemanticType;
  unit?: string;
  sortOrder?: readonly string[];
  intrinsicDomain?: readonly [number, number];
}>;

export type FlintEncoding =
  | string
  | Readonly<{
    field?: string;
    type?: "quantitative" | "nominal" | "ordinal" | "temporal";
    aggregate?: "count" | "sum" | "average" | "mean";
    sortOrder?: "ascending" | "descending";
    sortBy?: string;
  }>
  | readonly (string | Readonly<{ field?: string }>)[];

export type FlintChartSpec = Readonly<{
  chartType: FlintChartType;
  title: string;
  subtitle: string;
  encodings: Readonly<Record<string, FlintEncoding>>;
  chartProperties?: Readonly<Record<string, unknown>>;
}>;

export type FlintPlan = Readonly<{
  rationale: string;
  semantic_types: Readonly<Record<string, FlintSemanticType | FlintSemanticAnnotation>>;
  field_display_names?: Readonly<Record<string, string>>;
  chart_spec: FlintChartSpec;
  data: readonly Readonly<Record<string, unknown>>[];
}>;

export type TestChartSuiteCase = Readonly<{
  id: string;
  family: string;
  question: string;
  expected: readonly FlintChartType[];
  intent: string;
}>;

export const TEST_CHART_SUITE: readonly TestChartSuiteCase[] = [
  {
    id: "trend",
    family: "Trend",
    question: "How did coffee sales change each month last year?",
    expected: ["Line Chart", "Area Chart"],
    intent: "Continuous change over a time axis",
  },
  {
    id: "rank",
    family: "Ranking",
    question: "Which workshop services make the most revenue?",
    expected: ["Bar Chart", "Lollipop Chart"],
    intent: "Rank named categories by one measure",
  },
  {
    id: "grouped",
    family: "Comparison",
    question: "Compare this year's monthly revenue with last year, side by side.",
    expected: ["Grouped Bar Chart"],
    intent: "Like-for-like values sitting beside each other",
  },
  {
    id: "stack",
    family: "Composition",
    question: "How did the mix of walk-ins, repeats and referrals change each month?",
    expected: ["Stacked Bar Chart", "Area Chart", "Streamgraph"],
    intent: "Parts of a whole moving through time",
  },
  {
    id: "share",
    family: "Share",
    question: "What share of bookings come from walk-ins, repeats and referrals?",
    expected: ["Pie Chart"],
    intent: "A small static split of one whole",
  },
  {
    id: "scatter",
    family: "Relationship",
    question: "Is there a link between ticket size and return visits?",
    expected: ["Scatter Plot", "Regression"],
    intent: "Two measures plotted against each other",
  },
  {
    id: "histogram",
    family: "Distribution",
    question: "What is the distribution of repair times?",
    expected: ["Histogram", "Density Plot", "Boxplot", "Violin Plot"],
    intent: "The shape of one measure",
  },
  {
    id: "funnel",
    family: "Stages",
    question: "How does the checkout funnel drop from visit to paid?",
    expected: ["Bar Chart", "Lollipop Chart"],
    intent: "Ordered conversion stages (Vega-Lite has no funnel)",
  },
  {
    id: "bullet",
    family: "Target",
    question: "How does each advisor sit against their monthly sales quota?",
    expected: ["Bullet Chart"],
    intent: "Actual versus a named target",
  },
  {
    id: "slope",
    family: "Change",
    question: "How did each region's profit change from last year to this year?",
    expected: ["Slope Chart"],
    intent: "Two-period change per category",
  },
  {
    id: "bump",
    family: "Rank over time",
    question: "How did the rank of our top products move month by month?",
    expected: ["Bump Chart"],
    intent: "Rank position through time",
  },
  {
    id: "waterfall",
    family: "Bridge",
    question: "Walk from opening cash to closing cash through the month's movements.",
    expected: ["Waterfall Chart"],
    intent: "Start, signed movements, then an end total",
  },
  {
    id: "heatmap",
    family: "Grid",
    question: "When in the week are workshop bays busiest?",
    expected: ["Heatmap"],
    intent: "Two discrete axes and one intensity",
  },
  {
    id: "calendar",
    family: "Calendar",
    question: "Which days this year were the busiest for bookings?",
    expected: ["Calendar Heatmap"],
    intent: "Daily values on a calendar",
  },
];

export const TEST_CHART_EXAMPLES = TEST_CHART_SUITE.map((item) => item.question);

export type TestChartResult = Readonly<{
  question: string;
  invented: true;
  source: TestChartSource;
  chartType: FlintChartType;
  title: string;
  subtitle: string;
  rationale: string;
  appearance: TestChartAppearance;
  verdict: TestChartVerdict;
  expectedChartTypes: readonly FlintChartType[];
  suiteId: string | null;
  warnings: readonly string[];
  flint: Readonly<{
    semantic_types: FlintPlan["semantic_types"];
    field_display_names?: FlintPlan["field_display_names"];
    chart_spec: FlintChartSpec;
  }>;
  data: readonly Readonly<Record<string, unknown>>[];
}>;

const chartTypeByLower = new Map(FLINT_CHART_TYPES.map((name) => [name.toLowerCase(), name]));
const semanticTypeByLower = new Map(FLINT_SEMANTIC_TYPES.map((name) => [name.toLowerCase(), name]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

export function isFlintChartType(value: unknown): value is FlintChartType {
  return typeof value === "string" && chartTypeByLower.has(value.toLowerCase());
}

export function normalizeFlintChartType(value: unknown): FlintChartType | null {
  if (typeof value !== "string") return null;
  return chartTypeByLower.get(value.trim().toLowerCase()) ?? null;
}

export function normalizeFlintSemanticType(value: unknown): FlintSemanticType | null {
  if (typeof value !== "string") return null;
  return semanticTypeByLower.get(value.trim().toLowerCase()) ?? null;
}

export function testChartLabel(chartType: FlintChartType): string {
  return chartType;
}

export function extractJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/u);
  const text = (fenced?.[1] ?? raw).trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function matchSuiteCase(question: string): TestChartSuiteCase | null {
  const needle = question.trim();
  return TEST_CHART_SUITE.find((item) => item.question === needle) ?? null;
}

export function suiteVerdict(
  chartType: FlintChartType,
  question: string,
): Pick<TestChartResult, "verdict" | "expectedChartTypes" | "suiteId"> {
  const suite = matchSuiteCase(question);
  if (!suite) return { verdict: "open", expectedChartTypes: [], suiteId: null };
  return {
    verdict: suite.expected.includes(chartType) ? "pass" : "miss",
    expectedChartTypes: suite.expected,
    suiteId: suite.id,
  };
}

export function classifyTestChartQuestion(question: string): FlintChartType {
  const text = question.toLowerCase();
  if (/\b(funnel|conversion|drop[-\s]?off|checkout)\b/u.test(text)) return "Bar Chart";
  if (/\b(histogram|distribution|spread of|frequency of)\b/u.test(text)) return "Histogram";
  if (/\b(calendar|which days?)\b/u.test(text)) return "Calendar Heatmap";
  if (/\b(heatmap|busiest hours?|when in the week)\b/u.test(text)) return "Heatmap";
  if (/\b(waterfall|opening cash|walk from)\b/u.test(text)) return "Waterfall Chart";
  if (/\b(quota|target|against (their|the) (goal|quota))\b/u.test(text)) return "Bullet Chart";
  if (/\b(rank of|rank .* month|bump)\b/u.test(text)) return "Bump Chart";
  if (/\b(from last year to this year|slope|two[-\s]?period)\b/u.test(text)) return "Slope Chart";
  if (/\b(radar|across dimensions|multi[-\s]?dimension)\b/u.test(text)) return "Radar Chart";
  if (/\b(scatter|correlation|relationship between|link between|vs\.?|versus)\b/u.test(text)
    && /\b(size|price|age|score|visits?|ticket|spend)\b/u.test(text)) {
    return "Scatter Plot";
  }
  if (
    /\b(side by side|this year.{0,40}last year|last year.{0,40}this year)\b/u.test(text)
    && !/\b(from last year to this year)\b/u.test(text)
  ) {
    return "Grouped Bar Chart";
  }
  if (/\b(mix|composition|share of .{0,24} (each|over|by) month)\b/u.test(text)) return "Stacked Bar Chart";
  if (/\b(area|volume over|cumulative)\b/u.test(text)) return "Area Chart";
  if (
    /\b(share|proportion|mix|breakdown|percent(?:age)?|split)\b/u.test(text)
    && !/\b(over time|each month|weekly|quarter|trend)\b/u.test(text)
  ) {
    return "Pie Chart";
  }
  if (/\b(trend|over time|each month|monthly|weekly|quarter|year by year|changed)\b/u.test(text)) {
    return "Line Chart";
  }
  return "Bar Chart";
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rng(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function scale(next: () => number, min: number, max: number): number {
  return Math.round(min + next() * (max - min));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function topicFromQuestion(question: string): string {
  const cleaned = question
    .replace(/[?!.,]/gu, " ")
    .replace(/\b(how|what|which|who|when|show|me|the|a|an|did|does|do|our|we|for|of|in|over|last|this|and|or|to|from|each|by|was|were|is|are|can|you|please)\b/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return titleCase(cleaned.slice(0, 56)) || "Made-up result";
}

function monthLabels(count: number): string[] {
  const labels: string[] = [];
  const cursor = new Date(Date.UTC(2026, 7, 1));
  cursor.setUTCMonth(cursor.getUTCMonth() - (count - 1));
  for (let index = 0; index < count; index += 1) {
    labels.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return labels;
}

function plan(
  chartType: FlintChartType,
  question: string,
  rationale: string,
  semantic_types: FlintPlan["semantic_types"],
  encodings: FlintChartSpec["encodings"],
  data: FlintPlan["data"],
  extras?: Readonly<{
    subtitle?: string;
    field_display_names?: FlintPlan["field_display_names"];
    chartProperties?: FlintChartSpec["chartProperties"];
  }>,
): FlintPlan {
  const topic = topicFromQuestion(question);
  return {
    rationale,
    semantic_types,
    ...(extras?.field_display_names ? { field_display_names: extras.field_display_names } : {}),
    chart_spec: {
      chartType,
      title: topic,
      subtitle: extras?.subtitle ?? "Invented figures for Albert's Flint test suite, not live tenant data.",
      encodings,
      ...(extras?.chartProperties ? { chartProperties: extras.chartProperties } : {}),
    },
    data,
  };
}

export function inventFallbackPlan(question: string): FlintPlan {
  const chartType = classifyTestChartQuestion(question);
  const next = rng(hashSeed(question));
  const months = monthLabels(8);
  const services = ["Servicing", "Tyres", "Brakes", "Detailing", "Diagnostics"];
  const channels = ["Walk-ins", "Repeats", "Referrals", "Website"];
  const regions = ["Sydney", "Melbourne", "Brisbane", "Perth"];

  if (chartType === "Line Chart" || chartType === "Area Chart") {
    return plan(
      chartType,
      question,
      chartType === "Area Chart"
        ? "An area chart shows volume accumulating through time."
        : "A line chart is the right form for a continuous trend over time.",
      { month: "YearMonth", revenue: "Price" },
      { x: { field: "month" }, y: { field: "revenue" } },
      months.map((month) => ({ month, revenue: scale(next, 3800, 9200) })),
      { subtitle: "Invented monthly revenue, AUD." },
    );
  }

  if (chartType === "Grouped Bar Chart") {
    return plan(
      "Grouped Bar Chart",
      question,
      "A grouped bar puts the two periods side by side so the eye compares like with like.",
      { month: "Month", year: "Year", revenue: "Price" },
      { x: { field: "month" }, y: { field: "revenue" }, group: { field: "year" } },
      months.flatMap((month) => ([
        { month: month.slice(5), year: "2025", revenue: scale(next, 3200, 7800) },
        { month: month.slice(5), year: "2026", revenue: scale(next, 3600, 8600) },
      ])),
      { subtitle: "Invented monthly revenue by year, AUD." },
    );
  }

  if (chartType === "Stacked Bar Chart") {
    return plan(
      "Stacked Bar Chart",
      question,
      "A stacked bar shows how the mix of parts adds up in each period.",
      { month: "YearMonth", channel: "Category", bookings: "Count" },
      { x: { field: "month" }, y: { field: "bookings" }, color: { field: "channel" } },
      months.flatMap((month) => channels.map((channel) => ({
        month,
        channel,
        bookings: scale(next, 18, 90),
      }))),
      { subtitle: "Invented booking counts by channel." },
    );
  }

  if (chartType === "Pie Chart") {
    return plan(
      "Pie Chart",
      question,
      "A pie is only honest for a small static share of one whole.",
      { channel: "Category", share: "Percentage" },
      { size: { field: "share" }, color: { field: "channel" } },
      [
        { channel: "Walk-ins", share: 38 },
        { channel: "Repeats", share: 31 },
        { channel: "Referrals", share: 18 },
        { channel: "Website", share: 13 },
      ],
      {
        subtitle: "Invented booking share, percent.",
        chartProperties: { innerRadius: 55 },
      },
    );
  }

  if (chartType === "Scatter Plot") {
    return plan(
      "Scatter Plot",
      question,
      "A scatter is the form that can show whether two measures move together.",
      { ticket_size: "Price", return_visits: "Quantity" },
      { x: { field: "ticket_size" }, y: { field: "return_visits" } },
      Array.from({ length: 16 }, () => ({
        ticket_size: scale(next, 40, 420),
        return_visits: scale(next, 1, 14),
      })),
      {
        subtitle: "Invented ticket size (AUD) against return visits.",
        field_display_names: { ticket_size: "Ticket size", return_visits: "Return visits" },
      },
    );
  }

  if (chartType === "Histogram") {
    return plan(
      "Histogram",
      question,
      "A histogram shows the shape of one measure, not a ranking of names.",
      { minutes: "Duration" },
      { x: { field: "minutes" } },
      Array.from({ length: 28 }, () => ({ minutes: scale(next, 12, 140) })),
      { subtitle: "Invented repair times, minutes." },
    );
  }

  if (chartType === "Bullet Chart") {
    return plan(
      "Bullet Chart",
      question,
      "A bullet chart puts each actual against its own target.",
      { advisor: "Name", sales: "Amount", quota: "Amount" },
      { y: { field: "advisor" }, x: { field: "sales" }, goal: { field: "quota" } },
      ["Avery", "Blair", "Casey", "Drew", "Eden"].map((advisor) => ({
        advisor,
        sales: scale(next, 18000, 42000),
        quota: 30000,
      })),
      { subtitle: "Invented advisor sales against a $30,000 quota, AUD." },
    );
  }

  if (chartType === "Slope Chart") {
    return plan(
      "Slope Chart",
      question,
      "A slope chart is the cleanest reading of two-period change per category.",
      { region: "Region", year: "Year", profit: "Profit" },
      { x: { field: "year" }, y: { field: "profit" }, color: { field: "region" } },
      regions.flatMap((region) => ([
        { region, year: "2025", profit: scale(next, 40, 180) * 1000 },
        { region, year: "2026", profit: scale(next, 50, 210) * 1000 },
      ])),
      { subtitle: "Invented regional profit, AUD." },
    );
  }

  if (chartType === "Bump Chart") {
    const products = ["House blend", "Single origin", "Retail beans", "Merch"];
    return plan(
      "Bump Chart",
      question,
      "A bump chart tracks rank, not raw value, so the crossing lines are the story.",
      { month: "YearMonth", product: "Category", rank: "Rank" },
      { x: { field: "month" }, y: { field: "rank" }, color: { field: "product" } },
      months.flatMap((month) => {
        const order = [...products].sort(() => next() - 0.5);
        return order.map((product, index) => ({ month, product, rank: index + 1 }));
      }),
      { subtitle: "Invented product rank by month." },
    );
  }

  if (chartType === "Waterfall Chart") {
    const opening = 82000;
    const deltas = [12400, -6100, 4300, -2800, 1900];
    const closing = opening + deltas.reduce((sum, value) => sum + value, 0);
    return plan(
      "Waterfall Chart",
      question,
      "A waterfall keeps the opening and closing totals and colours the signed steps between them.",
      { step: "Category", amount: "Amount" },
      { x: { field: "step" }, y: { field: "amount" } },
      [
        { step: "Opening", amount: opening },
        { step: "Takings", amount: deltas[0] },
        { step: "Wages", amount: deltas[1] },
        { step: "Parts", amount: deltas[2] },
        { step: "Rent", amount: deltas[3] },
        { step: "Other", amount: deltas[4] },
        { step: "Closing", amount: closing },
      ],
      {
        subtitle: "Invented cash movements, AUD.",
        chartProperties: { totals: "both" },
      },
    );
  }

  if (chartType === "Heatmap") {
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const hours = ["08:00", "10:00", "12:00", "14:00", "16:00"];
    return plan(
      "Heatmap",
      question,
      "A heatmap is the right grid when two discrete axes share one intensity.",
      {
        weekday: { semanticType: "Category", sortOrder: weekdays },
        hour: { semanticType: "Hour", sortOrder: hours },
        bays: "Quantity",
      },
      { x: { field: "weekday" }, y: { field: "hour" }, color: { field: "bays" } },
      weekdays.flatMap((weekday) => hours.map((hour) => ({
        weekday,
        hour,
        bays: scale(next, 1, 12),
      }))),
      { subtitle: "Invented busy-bay counts by weekday and hour." },
    );
  }

  if (chartType === "Calendar Heatmap") {
    const rows: Array<Record<string, unknown>> = [];
    const cursor = new Date(Date.UTC(2026, 0, 5));
    for (let index = 0; index < 42; index += 1) {
      rows.push({
        date: cursor.toISOString().slice(0, 10),
        bookings: scale(next, 4, 28),
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return plan(
      "Calendar Heatmap",
      question,
      "A calendar heatmap keeps daily values on the calendar the reader already knows.",
      { date: "Date", bookings: "Count" },
      { x: { field: "date" }, color: { field: "bookings" } },
      rows,
      { subtitle: "Invented daily bookings." },
    );
  }

  if (chartType === "Radar Chart") {
    const dimensions = ["Speed", "Care", "Value", "Trust", "Return"];
    return plan(
      "Radar Chart",
      question,
      "A radar compares several scored dimensions for a small set of series.",
      { dimension: "Category", score: "Score", team: "Category" },
      { x: { field: "dimension" }, y: { field: "score" }, color: { field: "team" } },
      ["Workshop", "Retail"].flatMap((team) => dimensions.map((dimension) => ({
        dimension,
        team,
        score: scale(next, 42, 96),
      }))),
      {
        subtitle: "Invented scores, 0 to 100.",
        chartProperties: { filled: true },
      },
    );
  }

  const stages = ["Visit", "Add to cart", "Checkout", "Paid"];
  if (/\b(funnel|conversion|drop[-\s]?off|checkout)\b/iu.test(question)) {
    let remaining = 1000;
    return plan(
      "Bar Chart",
      question,
      "Vega-Lite has no funnel template, so ordered bars keep the stage drop honest.",
      {
        stage: { semanticType: "Category", sortOrder: stages },
        customers: "Count",
      },
      {
        y: { field: "stage" },
        x: { field: "customers" },
      },
      stages.map((stage) => {
        const row = { stage, customers: remaining };
        remaining = Math.round(remaining * (0.45 + next() * 0.25));
        return row;
      }),
      { subtitle: "Invented checkout stage counts." },
    );
  }

  return plan(
    "Bar Chart",
    question,
    "A ranked horizontal bar is the clearest comparison of named categories.",
    { service: "Category", revenue: "Price" },
    {
      y: { field: "service", sortBy: "x", sortOrder: "descending" },
      x: { field: "revenue" },
    },
    services.map((service) => ({ service, revenue: scale(next, 2400, 18000) })),
    { subtitle: "Invented service revenue, AUD." },
  );
}

function encodingFieldNames(value: FlintEncoding): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === "string") return item.trim() ? [item.trim()] : [];
      return isNonemptyString(item.field) ? [item.field.trim()] : [];
    });
  }
  return isNonemptyString(value.field) ? [value.field.trim()] : [];
}

export function encodingFields(encodings: Readonly<Record<string, FlintEncoding>>): string[] {
  return [...new Set(Object.values(encodings).flatMap(encodingFieldNames))];
}

function parseSemanticEntry(value: unknown): FlintSemanticType | FlintSemanticAnnotation | null {
  const named = normalizeFlintSemanticType(value);
  if (named) return named;
  if (!isRecord(value)) return null;
  const semanticType = normalizeFlintSemanticType(value.semanticType);
  if (!semanticType) return null;
  const annotation: FlintSemanticAnnotation = { semanticType };
  if (isNonemptyString(value.unit)) {
    return {
      ...annotation,
      unit: value.unit.trim().slice(0, 24),
      ...(Array.isArray(value.sortOrder)
        ? { sortOrder: value.sortOrder.filter(isNonemptyString).map((item) => item.trim()).slice(0, 16) }
        : {}),
      ...(Array.isArray(value.intrinsicDomain)
        && value.intrinsicDomain.length === 2
        && isFiniteNumber(value.intrinsicDomain[0])
        && isFiniteNumber(value.intrinsicDomain[1])
        ? { intrinsicDomain: [value.intrinsicDomain[0], value.intrinsicDomain[1]] }
        : {}),
    };
  }
  if (Array.isArray(value.sortOrder)) {
    return {
      ...annotation,
      sortOrder: value.sortOrder.filter(isNonemptyString).map((item) => item.trim()).slice(0, 16),
    };
  }
  if (
    Array.isArray(value.intrinsicDomain)
    && value.intrinsicDomain.length === 2
    && isFiniteNumber(value.intrinsicDomain[0])
    && isFiniteNumber(value.intrinsicDomain[1])
  ) {
    return { ...annotation, intrinsicDomain: [value.intrinsicDomain[0], value.intrinsicDomain[1]] };
  }
  return annotation;
}

function parseEncoding(value: unknown): FlintEncoding | null {
  if (isNonemptyString(value)) return value.trim();
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (isNonemptyString(item)) return item.trim();
      if (isRecord(item) && isNonemptyString(item.field)) return { field: item.field.trim() };
      return null;
    });
    if (items.length === 0 || items.some((item) => item === null)) return null;
    return items as FlintEncoding;
  }
  if (!isRecord(value) || !isNonemptyString(value.field)) return null;
  const encoding: Extract<FlintEncoding, { field?: string }> = { field: value.field.trim() };
  if (value.type === "quantitative" || value.type === "nominal" || value.type === "ordinal" || value.type === "temporal") {
    return { ...encoding, type: value.type };
  }
  if (value.aggregate === "count" || value.aggregate === "sum" || value.aggregate === "average" || value.aggregate === "mean") {
    return { ...encoding, aggregate: value.aggregate };
  }
  if (value.sortOrder === "ascending" || value.sortOrder === "descending") {
    return {
      ...encoding,
      sortOrder: value.sortOrder,
      ...(isNonemptyString(value.sortBy) ? { sortBy: value.sortBy.trim() } : {}),
    };
  }
  if (isNonemptyString(value.sortBy)) return { ...encoding, sortBy: value.sortBy.trim() };
  return encoding;
}

function parseEncodings(value: unknown): Record<string, FlintEncoding> | null {
  if (!isRecord(value)) return null;
  const encodings: Record<string, FlintEncoding> = {};
  for (const [channel, raw] of Object.entries(value)) {
    const parsed = parseEncoding(raw);
    if (!parsed) return null;
    encodings[channel] = parsed;
  }
  return Object.keys(encodings).length > 0 ? encodings : null;
}

function parseRows(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length < 3 || value.length > 48) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of value) {
    if (!isRecord(row)) return null;
    const next: Record<string, unknown> = {};
    for (const [key, cell] of Object.entries(row)) {
      if (!key.trim()) return null;
      if (cell === null || typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean") {
        next[key] = typeof cell === "string" ? cell.trim().slice(0, 80) : cell;
        continue;
      }
      return null;
    }
    rows.push(next);
  }
  return rows;
}

export function validateFlintPlan(plan: FlintPlan): string | null {
  const required = REQUIRED_CHANNELS[plan.chart_spec.chartType] ?? [];
  const missing = required.filter((channel) => !(channel in plan.chart_spec.encodings));
  if (missing.length > 0) return `The ${plan.chart_spec.chartType} is missing ${missing.join(", ")}.`;
  const fields = encodingFields(plan.chart_spec.encodings);
  if (fields.length === 0) return "Every chart needs at least one encoded field.";
  const keys = new Set(plan.data.flatMap((row) => Object.keys(row)));
  const absent = fields.filter((field) => !keys.has(field));
  if (absent.length > 0) return `Encoded field ${absent.join(", ")} is not in the invented rows.`;
  for (const field of fields) {
    if (!(field in plan.semantic_types)) return `Field ${field} needs a Flint semantic type.`;
  }
  return null;
}

export function parseInventedPlanOrNull(value: unknown): FlintPlan | null {
  if (!isRecord(value)) return null;
  const chartType = normalizeFlintChartType(
    isRecord(value.chart_spec) ? value.chart_spec.chartType : value.chartType,
  );
  if (!chartType) return null;
  const specSource = isRecord(value.chart_spec) ? value.chart_spec : value;
  const encodings = parseEncodings(specSource.encodings);
  const rows = parseRows(value.data);
  if (!encodings || !rows) return null;
  const semanticSource = isRecord(value.semantic_types) ? value.semantic_types : {};
  const semantic_types: Record<string, FlintSemanticType | FlintSemanticAnnotation> = {};
  for (const field of encodingFields(encodings)) {
    const parsed = parseSemanticEntry(semanticSource[field]);
    if (!parsed) return null;
    semantic_types[field] = parsed;
  }
  if (!isNonemptyString(specSource.title) || !isNonemptyString(value.rationale)) return null;
  const field_display_names = isRecord(value.field_display_names)
    ? Object.fromEntries(
      Object.entries(value.field_display_names)
        .filter((entry): entry is [string, string] => isNonemptyString(entry[0]) && isNonemptyString(entry[1]))
        .map(([key, label]) => [key, label.trim().slice(0, 60)]),
    )
    : undefined;
  const chartProperties = isRecord(specSource.chartProperties) ? specSource.chartProperties : undefined;
  const parsed: FlintPlan = {
    rationale: value.rationale.trim().slice(0, 400),
    semantic_types,
    ...(field_display_names && Object.keys(field_display_names).length > 0 ? { field_display_names } : {}),
    chart_spec: {
      chartType,
      title: specSource.title.trim().slice(0, 160),
      subtitle: isNonemptyString(specSource.subtitle)
        ? specSource.subtitle.trim().slice(0, 200)
        : "Invented figures for Albert's Flint test suite, not live tenant data.",
      encodings,
      ...(chartProperties ? { chartProperties } : {}),
    },
    data: rows,
  };
  return validateFlintPlan(parsed) ? null : parsed;
}

export function parseInventedPlan(value: unknown, question: string): FlintPlan {
  return parseInventedPlanOrNull(value) ?? inventFallbackPlan(question);
}

export function flintTheme(appearance: TestChartAppearance): string | Readonly<Record<string, unknown>> {
  if (appearance === "dark") {
    return {
      extends: "powerbi",
      id: "albert-test-dark",
      ink: {
        surface: { canvas: "#1b1d20" },
      },
    };
  }
  return "swiss";
}

export function toChartAssemblyInput(
  plan: FlintPlan,
  appearance: TestChartAppearance,
): Readonly<Record<string, unknown>> {
  return {
    data: { values: plan.data.map((row) => ({ ...row })) },
    semantic_types: { ...plan.semantic_types },
    ...(plan.field_display_names ? { field_display_names: { ...plan.field_display_names } } : {}),
    theme_spec: flintTheme(appearance),
    chart_spec: {
      chartType: plan.chart_spec.chartType,
      title: plan.chart_spec.title,
      subtitle: plan.chart_spec.subtitle,
      encodings: { ...plan.chart_spec.encodings },
      baseSize: { width: 720, height: 400 },
      canvasSize: { width: 720, height: 400 },
      ...(plan.chart_spec.chartProperties ? { chartProperties: { ...plan.chart_spec.chartProperties } } : {}),
    },
    options: { addTooltips: false },
  };
}

export function parseTestChartResult(value: unknown): TestChartResult | null {
  if (!isRecord(value) || value.invented !== true) return null;
  if (!isNonemptyString(value.question) || !isNonemptyString(value.title) || !isNonemptyString(value.rationale)) return null;
  const chartType = normalizeFlintChartType(value.chartType);
  if (!chartType) return null;
  if (value.appearance !== "light" && value.appearance !== "dark") return null;
  if (value.source !== "luna" && value.source !== "fallback") return null;
  if (value.verdict !== "pass" && value.verdict !== "miss" && value.verdict !== "open") return null;
  if (!isRecord(value.flint) || !isRecord(value.flint.chart_spec)) return null;
  const encodings = parseEncodings(value.flint.chart_spec.encodings);
  const rows = parseRows(value.data);
  if (!encodings || !rows) return null;
  return {
    question: value.question.trim(),
    invented: true,
    source: value.source,
    chartType,
    title: value.title.trim(),
    subtitle: isNonemptyString(value.subtitle) ? value.subtitle.trim() : "",
    rationale: value.rationale.trim(),
    appearance: value.appearance,
    verdict: value.verdict,
    expectedChartTypes: Array.isArray(value.expectedChartTypes)
      ? value.expectedChartTypes.flatMap((item) => {
        const type = normalizeFlintChartType(item);
        return type ? [type] : [];
      })
      : [],
    suiteId: isNonemptyString(value.suiteId) ? value.suiteId : null,
    warnings: Array.isArray(value.warnings) ? value.warnings.filter(isNonemptyString) : [],
    flint: {
      semantic_types: isRecord(value.flint.semantic_types) ? value.flint.semantic_types as FlintPlan["semantic_types"] : {},
      ...(isRecord(value.flint.field_display_names)
        ? { field_display_names: value.flint.field_display_names as FlintPlan["field_display_names"] }
        : {}),
      chart_spec: {
        chartType,
        title: value.title.trim(),
        subtitle: isNonemptyString(value.subtitle) ? value.subtitle.trim() : "",
        encodings,
        ...(isRecord(value.flint.chart_spec.chartProperties)
          ? { chartProperties: value.flint.chart_spec.chartProperties }
          : {}),
      },
    },
    data: rows,
  };
}

export function flintPlanFromResult(result: TestChartResult): FlintPlan {
  return {
    rationale: result.rationale,
    semantic_types: result.flint.semantic_types,
    ...(result.flint.field_display_names
      ? { field_display_names: result.flint.field_display_names }
      : {}),
    chart_spec: result.flint.chart_spec,
    data: result.data,
  };
}

export const TEST_CHART_PLANNER_INSTRUCTIONS = [
  "You are Albert's Flint chart author. This is a playground: invent plausible fictional rows, then write a Flint ChartAssemblyInput.",
  "You write semantic_types and chart_spec. You never write Vega-Lite, ECharts, colours, fonts, ticks, or pixel layout. Flint's compiler derives those.",
  "Australian English. Currency AUD. Six to twelve rows unless a histogram (~24) or calendar heatmap (~40) needs more. Never more than 48 rows.",
  "Reply with JSON only: {rationale,semantic_types,field_display_names,chart_spec:{chartType,title,subtitle,encodings,chartProperties},data}.",
  "title is the finding in a sentence. subtitle names what is measured, of whom, when, and in what units.",
  "Use a registered Vega-Lite chartType exactly: Scatter Plot, Regression, Connected Scatter Plot, Ranged Dot Plot, Strip Plot, Bar Chart, Grouped Bar Chart, Stacked Bar Chart, Pyramid Chart, Lollipop Chart, Waterfall Chart, Gantt Chart, Bullet Chart, Histogram, Boxplot, ECDF Plot, Heatmap, Calendar Heatmap, Line Chart, Sparkline, Bump Chart, Slope Chart, Area Chart, Range Area Chart, Violin Plot, Streamgraph, Density Plot, Pie Chart, Rose Chart, Radar Chart, Candlestick Chart, Bar Table, KPI Card, Map, Choropleth.",
  "This playground compiles to Vega-Lite. Do not ask for Funnel, Sankey, Treemap, Sunburst, Word Cloud, or dual-axes. For a funnel, use a Bar Chart with stages on y in process order.",
  "Choose the form that makes the claim fastest. Trend over time: Line Chart (Area Chart for volume; Range Area Chart for a high-low band). Ranking of named categories: Bar Chart with the category on y, the measure on x, sortBy the measure descending (Lollipop if a few categories). Side-by-side like-for-like (this year vs last): Grouped Bar Chart, second category on group, never color. Parts of a whole over time: Stacked Bar Chart, part on color. Small static share of one whole, 3 to 6 parts, not a ranking: Pie Chart (innerRadius 55 for a donut). Two measures against each other: Scatter Plot (Regression if they asked for a fit). Shape of one measure: Histogram (Boxplot or Violin to compare groups). Actual vs a named target: Bullet Chart (goal required). Rank through time: Bump Chart, y is Rank. Two-period change per category: Slope Chart. Start, signed movements, end: Waterfall Chart; omit color; totals both. Two discrete axes plus intensity: Heatmap. Daily values: Calendar Heatmap. Several scored dimensions, 1 to 4 series: Radar Chart.",
  "Bar mix-up: Bar Chart is one series. Stacked Bar Chart uses color for the second category when totals matter. Grouped Bar Chart uses group for side-by-side values. Never put the grouping category on color when you want grouped bars.",
  "Waterfall color is reserved for a Type column of start/delta/end only. Omit color and let Flint colour the sign of y. Do not bind color to Increase/Decrease.",
  "Pie and donut: size is the slice value, color is the category.",
  "Several same-unit measures as series: y may be an array of field names. That fold owns the legend; do not also bind color. Different units never share an axis.",
  "Semantic types (do not invent names): DateTime Date Time Timestamp Year Quarter Month Week Day Hour YearMonth YearQuarter YearWeek Decade Duration Amount Price Quantity Count Number Percentage Profit PercentageChange Sentiment Correlation Temperature Rank Score ID Latitude Longitude Country State City Region Address ZipCode Category Name Status Boolean Direction Range Unknown. Price/Amount get currency and a zero baseline. Rank reverses the axis. Percentage is 0-100, not 0-1. Date/YearMonth make a temporal axis. If unsure: Quantity, Category, or Date.",
  "Inspect the invented rows. Do not include a Total or All row next to its parts. One distinct value in a breakdown column means you picked the wrong field.",
  "Required channels: Scatter/Line/Bar/Lollipop x+y; Grouped Bar x+y+group; Stacked Bar x+y+color; Pie size+color; Bullet y+x+goal; Heatmap x+y+color; Calendar Heatmap x+color; Range Area x+y+y2; Candlestick x+open+high+low+close; Histogram x.",
  "Do not set type, aggregate, sortOrder, or chartProperties unless the default would mislead. Prefer field_display_names for readable axis titles, still encoding the real column name.",
  "Every encoded field must exist in data and in semantic_types. Reference only columns you invented.",
].join(" ");
