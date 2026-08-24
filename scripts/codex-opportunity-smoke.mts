import { createServer } from "node:http";
import { once } from "node:events";
import { ulid } from "ulid";

import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  ALBERT_CODEX_PINNED_CLI_VERSION,
  CodexRuntimeServiceClient,
} from "../packages/albert-codex/src/index.js";
import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";
import { CodexRuntimeHttpHandler } from "../services/codex-runtime/src/http.js";
import { buildSharedAnalyticalBrief } from "../services/conversation/src/analytical-brief.js";

type MetaMember = Readonly<{
  name: string;
  title: string;
  shortTitle: string;
  description: string;
  type: string;
  format?: string;
}>;

const measure = (name: string, title: string, format?: string): MetaMember => ({
  name,
  title,
  shortTitle: title,
  description: `Synthetic governed ${title.toLowerCase()}.`,
  type: "number",
  ...(format ? { format } : {}),
});
const dimension = (name: string, title: string, type = "string"): MetaMember => ({
  name,
  title,
  shortTitle: title,
  description: `Synthetic governed ${title.toLowerCase()}.`,
  type,
});

const cubes = [
  {
    name: "sales_analytics",
    title: "Sales analytics",
    description: "Synthetic completed POS sales baseline and commercial performance.",
    public: true,
    measures: [
      measure("sales_analytics.gross_takings", "Gross takings", "currency"),
      measure("sales_analytics.net_sales", "Net sales", "currency"),
      measure("sales_analytics.transactions", "Transactions"),
      measure("sales_analytics.average_sale_value", "Average sale value", "currency"),
      measure("sales_analytics.gross_profit", "Gross profit", "currency"),
      measure("sales_analytics.gross_margin_pct", "Gross margin", "percent"),
    ],
    dimensions: [dimension("sales_analytics.completed_at", "Completed at", "time")],
    segments: [{ name: "sales_analytics.completed_sales", title: "Completed sales", shortTitle: "Completed sales" }],
  },
  {
    name: "customer_analytics",
    title: "Customer analytics",
    description: "Synthetic aggregate customer value, recency and safe contactability.",
    public: true,
    measures: [
      measure("customer_analytics.customer_count", "Customer count"),
      measure("customer_analytics.total_lifetime_revenue", "Total lifetime revenue", "currency"),
      measure("customer_analytics.average_lifetime_revenue", "Average lifetime revenue", "currency"),
      measure("customer_analytics.repeat_purchase_rate_pct", "Repeat purchase rate", "percent"),
    ],
    dimensions: [
      dimension("customer_analytics.days_since_last_purchase", "Days since last purchase", "number"),
      dimension("customer_analytics.is_repeat_customer", "Repeat customer", "boolean"),
      dimension("customer_analytics.contacts_has_email", "Has email", "boolean"),
      dimension("customer_analytics.contacts_no_email", "Email opt-out", "boolean"),
    ],
    segments: [{ name: "customer_analytics.active_customers", title: "Active customers", shortTitle: "Active customers" }],
  },
  {
    name: "workshop_analytics",
    title: "Workshop analytics",
    description: "Synthetic workshop intake and throughput.",
    public: true,
    measures: [
      measure("workshop_analytics.workorder_count", "Workorders"),
      measure("workshop_analytics.open_workorders", "Open workorders"),
      measure("workshop_analytics.closed_workorders", "Closed workorders"),
      measure("workshop_analytics.invoiced_workorders", "Invoiced workorders"),
    ],
    dimensions: [dimension("workshop_analytics.checked_in_at", "Checked in at", "time")],
    segments: [],
  },
  {
    name: "product_sales_analytics",
    title: "Product sales analytics",
    description: "Synthetic product, category and workshop-line economics.",
    public: true,
    measures: [
      measure("product_sales_analytics.line_revenue", "Line revenue", "currency"),
      measure("product_sales_analytics.line_net_revenue", "Line net revenue", "currency"),
      measure("product_sales_analytics.line_gross_profit", "Line gross profit", "currency"),
      measure("product_sales_analytics.line_count", "Sale line count"),
    ],
    dimensions: [
      dimension("product_sales_analytics.categories_full_path_name", "Category path"),
      dimension("product_sales_analytics.is_workorder", "Is workorder", "boolean"),
      dimension("product_sales_analytics.completed_at", "Completed at", "time"),
    ],
    segments: [],
  },
  {
    name: "inventory_analytics",
    title: "Inventory analytics",
    description: "Synthetic current stock, ageing and reorder exposure.",
    public: true,
    measures: [
      measure("inventory_analytics.units_on_hand", "Units on hand"),
      measure("inventory_analytics.stock_value", "Stock value", "currency"),
      measure("inventory_analytics.distinct_items_in_stock", "Distinct items in stock"),
      measure("inventory_analytics.positions_below_reorder", "Positions below reorder"),
    ],
    dimensions: [
      dimension("inventory_analytics.stock_age_band", "Stock age band"),
      dimension("inventory_analytics.items_name", "Item name"),
    ],
    segments: [{ name: "inventory_analytics.in_stock", title: "In stock", shortTitle: "In stock" }],
  },
  {
    name: "workforce_analytics",
    title: "Workforce analytics",
    description: "Synthetic authoritative Deputy worked and rostered hours.",
    public: true,
    measures: [
      measure("workforce_analytics.hours_worked", "Hours worked"),
      measure("workforce_analytics.rostered_hours", "Rostered hours"),
      measure("workforce_analytics.wage_cost", "Wage cost", "currency"),
    ],
    dimensions: [dimension("workforce_analytics.shift_date", "Shift date", "time")],
    segments: [],
  },
  {
    name: "xero_finance_analytics",
    title: "Xero finance analytics",
    description: "Synthetic receivables, payables and cash constraints.",
    public: true,
    measures: [
      measure("xero_finance_analytics.receivable_outstanding", "Receivable outstanding", "currency"),
      measure("xero_finance_analytics.receivable_overdue", "Receivable overdue", "currency"),
      measure("xero_finance_analytics.payable_outstanding", "Payable outstanding", "currency"),
      measure("xero_finance_analytics.payable_overdue", "Payable overdue", "currency"),
      measure("xero_finance_analytics.cash_in", "Cash in", "currency"),
      measure("xero_finance_analytics.cash_out", "Cash out", "currency"),
    ],
    dimensions: [dimension("xero_finance_analytics.cash_date", "Cash date", "time")],
    segments: [],
  },
] as const;

const metaByName = new Map(cubes.flatMap((cube) => [
  ...cube.measures,
  ...cube.dimensions,
].map((member) => [member.name, member] as const)));

function annotationFor(key: string, sourceName: string) {
  const source = metaByName.get(sourceName);
  const type = source?.type === "time" ? "time" : source?.type ?? "number";
  return {
    title: source?.title ?? key,
    shortTitle: source?.shortTitle ?? key,
    type,
    ...(source?.format ? { format: source.format } : {}),
  };
}

function rowsForQuery(query: Record<string, unknown>): readonly Record<string, unknown>[] {
  const measures = Array.isArray(query.measures) ? query.measures as string[] : [];
  const dimensions = Array.isArray(query.dimensions) ? query.dimensions as string[] : [];
  const times = Array.isArray(query.timeDimensions) ? query.timeDimensions as Array<Record<string, unknown>> : [];
  const view = [...measures, ...dimensions, ...times.map((time) => String(time.dimension ?? ""))][0]?.split(".")[0] ?? "";
  const time = times[0];
  const granularity = typeof time?.granularity === "string" ? time.granularity : undefined;
  const timeName = typeof time?.dimension === "string" ? time.dimension : undefined;
  const timeKey = timeName && granularity ? `${timeName}.${granularity}` : timeName;
  const project = (row: Record<string, unknown>) => Object.fromEntries([
    ...dimensions.map((key) => [key, row[key] ?? null] as const),
    ...(timeKey ? [[timeKey, row[timeKey] ?? row[timeName!] ?? null] as const] : []),
    ...measures.map((key) => [key, row[key] ?? null] as const),
  ]);

  if (view === "workshop_analytics") {
    return [
      ["2026-02-01T00:00:00.000", 196, 196, 0, 189],
      ["2026-03-01T00:00:00.000", 182, 182, 0, 176],
      ["2026-04-01T00:00:00.000", 171, 171, 0, 166],
      ["2026-05-01T00:00:00.000", 155, 155, 0, 150],
      ["2026-06-01T00:00:00.000", 141, 141, 0, 137],
      ["2026-07-01T00:00:00.000", 127, 127, 0, 124],
    ].map(([month, count, open, closed, invoiced]) => project({
      [timeKey ?? "workshop_analytics.checked_in_at.month"]: month,
      "workshop_analytics.workorder_count": count,
      "workshop_analytics.open_workorders": open,
      "workshop_analytics.closed_workorders": closed,
      "workshop_analytics.invoiced_workorders": invoiced,
    }));
  }
  if (view === "customer_analytics") {
    return [project({
      "customer_analytics.customer_count": 430,
      "customer_analytics.total_lifetime_revenue": 612450.25,
      "customer_analytics.average_lifetime_revenue": 1424.303,
      "customer_analytics.repeat_purchase_rate_pct": 47.62,
      "customer_analytics.days_since_last_purchase": 240,
      "customer_analytics.is_repeat_customer": "true",
      "customer_analytics.contacts_has_email": "true",
      "customer_analytics.contacts_no_email": "false",
    })];
  }
  if (view === "product_sales_analytics") {
    if (dimensions.includes("product_sales_analytics.categories_full_path_name")) {
      return [
        ["Services", 129779.83, 108430.13, 76142.44, 2110],
        ["Bikes/City", 102400.25, 93091.14, 40200.18, 92],
        ["Parts/Wheels & Tyres", 87420.55, 79473.23, 46815.74, 1430],
      ].map(([category, revenue, netRevenue, profit, count]) => project({
        "product_sales_analytics.categories_full_path_name": category,
        "product_sales_analytics.line_revenue": revenue,
        "product_sales_analytics.line_net_revenue": netRevenue,
        "product_sales_analytics.line_gross_profit": profit,
        "product_sales_analytics.line_count": count,
      }));
    }
    return [project({
      [timeKey ?? "product_sales_analytics.completed_at.month"]: "2026-07-01T00:00:00.000",
      "product_sales_analytics.is_workorder": "true",
      "product_sales_analytics.line_revenue": 25011.29,
      "product_sales_analytics.line_net_revenue": 22737.54,
      "product_sales_analytics.line_gross_profit": 18293.16,
      "product_sales_analytics.line_count": 412,
    })];
  }
  if (view === "inventory_analytics") {
    if (dimensions.includes("inventory_analytics.stock_age_band")) {
      return [
        ["0-90 days", 520, 118400, 180, 8],
        ["91-180 days", 210, 52750, 86, 5],
        ["Over 365 days", 145, 68420, 61, 2],
      ].map(([band, units, value, items, belowReorder]) => project({
        "inventory_analytics.stock_age_band": band,
        "inventory_analytics.units_on_hand": units,
        "inventory_analytics.stock_value": value,
        "inventory_analytics.distinct_items_in_stock": items,
        "inventory_analytics.positions_below_reorder": belowReorder,
      }));
    }
    return [project({
      "inventory_analytics.units_on_hand": 875,
      "inventory_analytics.stock_value": 239570,
      "inventory_analytics.distinct_items_in_stock": 327,
      "inventory_analytics.positions_below_reorder": 15,
    })];
  }
  if (view === "workforce_analytics") {
    return [project({
      [timeKey ?? "workforce_analytics.shift_date.month"]: "2026-07-01T00:00:00.000",
      "workforce_analytics.hours_worked": 1049.6,
      "workforce_analytics.rostered_hours": 1040.5,
      "workforce_analytics.wage_cost": 31820.45,
    })];
  }
  if (view === "xero_finance_analytics") {
    return [project({
      [timeKey ?? "xero_finance_analytics.cash_date.month"]: "2026-07-01T00:00:00.000",
      "xero_finance_analytics.receivable_outstanding": 48750.25,
      "xero_finance_analytics.receivable_overdue": 12110.4,
      "xero_finance_analytics.payable_outstanding": 36120.8,
      "xero_finance_analytics.payable_overdue": 8420.1,
      "xero_finance_analytics.cash_in": 146300.75,
      "xero_finance_analytics.cash_out": 139850.2,
    })];
  }
  return [project({
    [timeKey ?? "sales_analytics.completed_at.month"]: "2026-07-01T00:00:00.000",
    "sales_analytics.gross_takings": 136233.12,
    "sales_analytics.net_sales": 132801.55,
    "sales_analytics.transactions": 954,
    "sales_analytics.average_sale_value": 142.802,
    "sales_analytics.gross_profit": 77684.43,
    "sales_analytics.gross_margin_pct": 58.61,
  })];
}

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
if (!apiKey) throw new Error("OPENAI_API_KEY is unavailable for the synthetic opportunity smoke test.");

const cube = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith("/cubejs-api/v1/meta")) {
    response.end(JSON.stringify({ cubes }));
    return;
  }
  const queryText = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("query") ?? "{}";
  const query = JSON.parse(queryText) as Record<string, unknown>;
  const rows = rowsForQuery(query);
  const first = rows[0] ?? {};
  const annotation = Object.fromEntries(Object.keys(first).map((key) => {
    const sourceName = key.replace(/\.(?:second|minute|hour|day|week|month|quarter|year)$/u, "");
    return [key, annotationFor(key, sourceName)];
  }));
  response.end(JSON.stringify({
    data: rows,
    annotation: {
      measures: Object.fromEntries(Object.entries(annotation).filter(([key]) => metaByName.get(key)?.type === "number")),
      dimensions: Object.fromEntries(Object.entries(annotation).filter(([key]) => metaByName.get(key)?.type !== "number")),
      timeDimensions: Object.fromEntries(Object.entries(annotation).filter(([key]) => key.match(/\.(?:second|minute|hour|day|week|month|quarter|year)$/u))),
    },
  }));
});

cube.listen(0, "127.0.0.1");
await once(cube, "listening");
const address = cube.address();
if (!address || typeof address === "string") throw new Error("Synthetic Cube server did not start.");

const runtimeHandler = new CodexRuntimeHttpHandler({
  port: 0,
  listenHost: "127.0.0.1" as const,
  signingSecret: ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  cubeApiUrl: `http://127.0.0.1:${address.port}`,
  authentication: {
    mode: "api" as const,
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  },
  ...(process.env.ALBERT_CODEX_BINARY_PATH?.trim()
    ? { binaryPath: process.env.ALBERT_CODEX_BINARY_PATH.trim() }
    : {}),
  maxConcurrentTurns: 1,
  pinnedCliVersion: ALBERT_CODEX_PINNED_CLI_VERSION,
  releaseSha: "development",
  deploymentId: "opportunity-smoke",
});
const runtimeServer = createServer((incoming, outgoing) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
      else if (value) headers.set(key, value);
    }
    const response = await runtimeHandler.handle(new Request(`http://127.0.0.1${incoming.url ?? "/"}`, {
      method: incoming.method ?? "GET",
      headers,
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
    }));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => outgoing.setHeader(key, value));
    if (!response.body) {
      outgoing.end();
      return;
    }
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      outgoing.write(Buffer.from(value));
    }
    outgoing.end();
  })().catch(() => outgoing.destroy());
});
runtimeServer.listen(0, "127.0.0.1");
await once(runtimeServer, "listening");
const runtimeAddress = runtimeServer.address();
if (!runtimeAddress || typeof runtimeAddress === "string") throw new Error("Synthetic Codex service did not start.");

const tenantId = ulid();
const conversationId = ulid();
const turnId = ulid();
const message = process.env.CODEX_SMOKE_PROMPT?.trim()
  || "Find one high-confidence opportunity I could test this month";
const analysisBrief = buildSharedAnalyticalBrief({
  message,
  activeConnectors: ["lightspeed-r", "deputy", "xero"],
  connectorFreshness: [{ connector: "lightspeed", dataThrough: "2026-08-20" }],
});
const cubeBearer = signCubeJwt({
  secret: "s".repeat(48),
  expiresInSeconds: 900,
  securityContext: {
    tenant_id: tenantId,
    role: "owner",
    specialist_agent_id: "general",
    specialist_agent_version: 1,
    conversation_id: conversationId,
    turn_id: turnId,
  },
});
const events: Array<{ type: string; [key: string]: unknown }> = [];
const startedAt = Date.now();
try {
  const client = new CodexRuntimeServiceClient(
    `http://127.0.0.1:${runtimeAddress.port}`,
    ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  );
  const result = await client.runTurn({
      protocolVersion: 1,
      requestId: ulid(),
      tenantId,
      actorId: "11111111-1111-4111-8111-111111111111",
      role: "owner",
      conversationId,
      turnId,
      message,
      priorConversation: [],
      priorResults: [],
      activeConnectors: ["lightspeed-r", "deputy", "xero"],
      connectorFreshness: [{ connector: "lightspeed", domain: "sales", dataThrough: "2026-08-20" }],
      ...(analysisBrief ? { analysisBrief } : {}),
      cubeBearer,
      model: "gpt-5.6-luna",
      effort: "max",
      fastMode: true,
    }, (event) => events.push(event));
  const queryViews = events.filter((event) => event.type === "query").map((event) => String(event.view ?? ""));
  const answer = events.findLast((event) => event.type === "answer");
  const answerText = String(answer?.text ?? "");
  const healthCheck = /health check/iu.test(message);
  const requiredViews = healthCheck
    ? ["sales_analytics", "customer_analytics", "inventory_analytics", "xero_finance_analytics"]
    : [
        "sales_analytics",
        "customer_analytics",
        "product_sales_analytics",
        "inventory_analytics",
        "workshop_analytics",
        "workforce_analytics",
        "xero_finance_analytics",
      ];
  const passed = result.answerState !== "Unavailable"
    && requiredViews.every((view) => queryViews.includes(view))
    && /\b(?:test|experiment|pilot)\b/iu.test(answerText)
    && events.some((event) => event.type === "plan")
    && !events.some((event) => event.type === "error")
    && !/\d+\.\d{3,}/u.test(answerText.replace(/\d{4}-\d{2}-\d{2}/gu, ""));
  process.stdout.write(`${JSON.stringify({
    syntheticOnly: true,
    prompt: message,
    transport: "loopback-job-poll",
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: true,
    passed,
    answerState: result.answerState,
    queryCount: queryViews.length,
    queryViews,
    planEvents: events.filter((event) => event.type === "plan").length,
    evidenceUpdates: events.filter((event) => event.type === "narrative").length,
    answerFormatted: !/\d+\.\d{3,}/u.test(answerText.replace(/\d{4}-\d{2}-\d{2}/gu, "")),
    durationMs: Date.now() - startedAt,
  }, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
} finally {
  runtimeServer.close();
  await once(runtimeServer, "close");
  cube.close();
  await once(cube, "close");
}
