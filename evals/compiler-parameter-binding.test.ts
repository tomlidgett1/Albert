import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { compileSemanticQuery } from "../packages/compiler/src/index.js";
import { loadRegistryFile } from "../packages/semantic-registry/src/index.js";

const registry = loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const capabilities = new Set([...registry.metrics.values()].flatMap((metric) => metric.requiredCapabilities));

const context = {
  tenantId: "01KZ4ZMVF5QNQ4TX35VF3WDJBM",
  role: "owner",
  capabilities,
  now: "2026-08-05T00:00:00.000Z",
  timezone: "Australia/Melbourne",
  tradingDayCutoff: "00:00",
  fiscalYearStartMonth: 7,
  fiscalYearStartDay: 1,
  weekStartsOn: 1,
  tenantParameters: { active_customer_days: 90, lapsed_customer_days: 90, stock_velocity_days: 30 },
  defaults: {},
  overlayVersion: "test",
  packVersions: {},
  sourceWatermarks: {},
} as unknown as Parameters<typeof compileSemanticQuery>[2];

function topicFor(metricId: string): string | undefined {
  for (const topic of registry.topics.values()) if (topic.metrics.includes(metricId)) return topic.id;
  return undefined;
}

function boundParameters(sql: string): readonly number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

/**
 * PostgreSQL infers a bound parameter's type from the placeholder that uses it.
 * A value supplied without a matching `$n` anywhere in the statement makes the
 * whole query fail to parse with "could not determine data type of parameter
 * $n", so a metric that allocates a parameter it never renders is unusable —
 * which is exactly how commerce.transactions, commerce.units_sold and the
 * windowed customer metrics silently broke.
 */
test("every governed metric compiles to a fully referenced parameter list", () => {
  const unusable: string[] = [];
  for (const metric of registry.metrics.values()) {
    const topic = topicFor(metric.id);
    if (!topic) continue;
    let compiled;
    try {
      compiled = compileSemanticQuery({
        topic,
        metrics: [metric.id],
        dimensions: [],
        filters: [],
        time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
        sort: [],
        limit: 20,
        parameters: {},
      } as never, registry, context);
    } catch {
      // Capability- or contract-rejected metrics fail closed elsewhere; this
      // test is only about parameter binding for the ones that do compile.
      continue;
    }
    const used = boundParameters(compiled.sql);
    const supplied = compiled.parameters.length;
    const expected = Array.from({ length: supplied }, (_, index) => index + 1);
    if (used.length !== supplied || used.some((value, index) => value !== expected[index])) {
      unusable.push(`${metric.id}: supplied ${supplied}, referenced ${JSON.stringify(used)}`);
    }
  }
  assert.deepEqual(unusable, [], `metrics binding unreferenced parameters:\n${unusable.join("\n")}`);
});

test("a multi-metric query keeps one contiguous parameter list", () => {
  const compiled = compileSemanticQuery({
    topic: "sales_performance",
    metrics: ["commerce.net_sales_ex_gst", "commerce.transactions", "commerce.units_sold", "commerce.gross_margin_pct"],
    dimensions: ["worker"],
    filters: [],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [{ metric: "commerce.net_sales_ex_gst", dir: "desc" }],
    limit: 10,
    parameters: {},
  } as never, registry, context);

  const used = boundParameters(compiled.sql);
  assert.equal(used.length, compiled.parameters.length);
  assert.deepEqual(used, Array.from({ length: compiled.parameters.length }, (_, index) => index + 1));
});

/**
 * A semi-additive measure must read only its latest snapshot per entity. Doing
 * that with a correlated subquery re-executes the whole relation once per row,
 * which is unusable when the relation is a view — every inventory question
 * timed out. The value must come from a single window pass instead.
 */
test("semi-additive metrics resolve their latest snapshot without a correlated rescan", () => {
  const compiled = compileSemanticQuery({
    topic: "inventory_health",
    metrics: ["inventory.stock_on_hand_units", "inventory.stock_on_hand_value"],
    dimensions: [],
    filters: [],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context);

  // No rescan of the fact relation for the latest snapshot.
  assert.doesNotMatch(compiled.sql, /SELECT MAX\([a-z_]*snapshot_latest/iu);
  assert.doesNotMatch(compiled.sql, /IS NOT DISTINCT FROM/iu);

  // One window pass, partitioned on the identity-resolved snapshot keys.
  assert.match(compiled.sql, /MAX\(base\."snapshot_date"\) FILTER \(WHERE base\."quantity_on_hand" IS NOT NULL\) OVER \(PARTITION BY /u);
  assert.match(compiled.sql, /COALESCE\(snapshot_identity0\."resolved_entity_id", base\."product_variant_id"\)/u);
  assert.match(compiled.sql, /f\."snapshot_date" = f\."__snapshot_latest__quantity_on_hand"/u);

  // The window input keeps the tenant and metric time bound the correlated form used.
  assert.match(compiled.sql, /WHERE base\."tenant_id" = \$1 AND base\."snapshot_date" >= \$\d+ AND base\."snapshot_date" < \$\d+/u);

  // Each measured field gets its own latest, so a null-valued field cannot
  // borrow another field's snapshot date.
  assert.match(compiled.sql, /AS "__snapshot_latest__stock_value"/u);

  const used = [...new Set([...compiled.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
  assert.deepEqual(used, Array.from({ length: compiled.parameters.length }, (_, i) => i + 1));
});

/**
 * A dimension filter has to accept the value the caller can actually see.
 * list_field_values returns the display label, result rows show the label, and
 * a person names the label — but the fact table only carries the key. Matching
 * the key alone answered "no sales in Drivetrain" for a category that sells,
 * which is worse than an error because it reads as a real answer.
 */
test("dimension filters match the display label as well as the key", () => {
  const compiled = compileSemanticQuery({
    topic: "sales_performance",
    metrics: ["commerce.net_sales_ex_gst"],
    dimensions: [],
    filters: [{ field: "product.category", op: "eq", values: ["Drivetrain"] }],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context);

  // The dimension is joined even though it is not grouped by, so the label is reachable.
  assert.match(compiled.sql, /LEFT JOIN "core"\."product_category"/u);
  // Either the key or the label satisfies a positive filter.
  assert.match(compiled.sql, /\(f\."product_category_id" = \$\d+ OR d\d+\."name" = \$\d+\)/u);
  assert.ok(compiled.parameters.filter((value) => value === "Drivetrain").length === 2);
  // Joining for the filter must not add a grouping key.
  assert.doesNotMatch(compiled.sql, /GROUP BY/u);
});

test("a negative dimension filter excludes on either the key or the label", () => {
  const compiled = compileSemanticQuery({
    topic: "sales_performance",
    metrics: ["commerce.net_sales_ex_gst"],
    dimensions: [],
    filters: [{ field: "product.category", op: "not_in", values: ["Services"] }],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context);

  // The exact complement of the positive match: a row matching either
  // identifier is excluded, and a row matching neither is kept even when one
  // side is NULL.
  assert.match(compiled.sql, /\(\(f\."product_category_id" IN \(\$\d+\) OR d\d+\."name" IN \(\$\d+\)\) IS NOT TRUE\)/u);
});

/**
 * PostgreSQL only accepts merge- or hash-joinable conditions in a FULL OUTER
 * JOIN and rejects the whole statement with 0A000 otherwise. The compiler has
 * three of them — period comparison, composite period comparison, and the
 * aggregate-then-align path — and each one silently broke a whole class of
 * question until it was found.
 */
test("no FULL OUTER JOIN aligns on a non-hash-joinable operator", async () => {
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile("packages/compiler/src/compiler.ts", "utf8"));
  // Comments may discuss it; emitted SQL must never contain it.
  const emitted = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n");
  assert.doesNotMatch(emitted, /IS NOT DISTINCT FROM/u);
});

test("composite aggregate-then-align joins on a hash-joinable condition", () => {
  const compiled = compileSemanticQuery({
    kind: "composite",
    topic: "workforce_sales",
    metrics: ["composites.sales_per_labour_hour"],
    queries: [
      {
        topic: "workforce_sales",
        metrics: ["commerce.net_sales_ex_gst"],
        dimensions: ["worker"],
        filters: [],
        time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
        parameters: {},
      },
      {
        topic: "workforce_sales",
        metrics: ["workforce.worked_hours"],
        dimensions: ["worker"],
        filters: [],
        time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
        parameters: {},
      },
    ],
    alignOn: ["worker"],
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context);

  assert.match(compiled.sql, /FULL OUTER JOIN/u);
  assert.doesNotMatch(compiled.sql, /IS NOT DISTINCT FROM/u);
  assert.match(compiled.sql, /COALESCE\(CAST\(.*AS text\), ''\) = COALESCE\(CAST\(/u);
});

/**
 * "Same period" must mean the same number of days. Shifting both endpoints
 * independently does not, because months are unequal and a month end clamps:
 * 29 Jul - 5 Aug (7 days) became 29 Jun - 5 Jul (6 days). The change
 * percentage was then computed against a shorter window and presented as a
 * like-for-like comparison — a wrong number, not a missing one.
 */
test("a period comparison window has the same length as the period it compares", () => {
  const dayMs = 86_400_000;
  const lengthOf = (range: { fromBusinessDate: string; toBusinessDate: string }) =>
    Math.round((Date.parse(range.toBusinessDate) - Date.parse(range.fromBusinessDate)) / dayMs);

  for (const [compare, now] of [
    // Window straddling a month boundary, where the months differ in length.
    ["same_period_prior_month", "2026-08-05T00:00:00.000Z"],
    // Window ending on a month end, which addMonths would clamp.
    ["same_period_prior_month", "2026-03-31T00:00:00.000Z"],
    ["same_period_prior_year", "2026-03-01T00:00:00.000Z"],
    ["same_period_prior_week", "2026-08-05T00:00:00.000Z"],
  ] as const) {
    const compiled = compileSemanticQuery({
      topic: "sales_performance",
      metrics: ["commerce.net_sales_ex_gst"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: { type: "last_n_days", days: 7 }, compare },
      sort: [],
      limit: 20,
      parameters: {},
    } as never, registry, { ...context, now } as never);

    const resolved = compiled.resolvedTime as unknown as {
      fromBusinessDate: string;
      toBusinessDate: string;
      comparisonFromBusinessDate?: string;
      comparisonToBusinessDate?: string;
    };
    assert.ok(resolved.comparisonFromBusinessDate && resolved.comparisonToBusinessDate);
    assert.equal(
      lengthOf({
        fromBusinessDate: resolved.comparisonFromBusinessDate,
        toBusinessDate: resolved.comparisonToBusinessDate,
      }),
      lengthOf(resolved),
      `${compare} at ${now} compared windows of different lengths`,
    );
  }
});

test("a filter on a dimension the metric refuses to group by is rejected", () => {
  // avg_order_value is order-grain: an order spans categories, so slicing it by
  // one produced a sliced numerator over a whole denominator.
  assert.throws(
    () => compileSemanticQuery({
      topic: "sales_performance",
      metrics: ["commerce.avg_order_value"],
      dimensions: [],
      filters: [{ field: "product.category", op: "eq", values: ["Drivetrain"] }],
      time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    } as never, registry, context),
    /is not allowed for commerce\.avg_order_value/u,
  );

  // The same dimension stays legal for a line-grain metric.
  assert.ok(compileSemanticQuery({
    topic: "sales_performance",
    metrics: ["commerce.net_sales_ex_gst"],
    dimensions: [],
    filters: [{ field: "product.category", op: "eq", values: ["Drivetrain"] }],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context).sql);
});

test("excluding a named dimension value keeps rows the dimension never attributed", () => {
  const compiled = compileSemanticQuery({
    topic: "sales_performance",
    metrics: ["commerce.net_sales_ex_gst"],
    dimensions: [],
    filters: [{ field: "worker", op: "neq", values: ["Leigh Phillips"] }],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context);

  // "Everyone except Leigh" must still include unattributed sales, or the
  // total stops reconciling against the unfiltered figure.
  // The exact complement of the positive match: any row that does not
  // positively match either identifier is retained, NULLs included.
  assert.match(compiled.sql, /\(\(.*IS NOT TRUE\)/u);
  assert.doesNotMatch(compiled.sql, /<> \$\d+ AND/u);
});

test("a calendar_week filter is not blocked by per-metric dimension rules", () => {
  // calendar_week is a derived time restriction that cannot change grain, and
  // most metric contracts omit it while the Topic approves it. Applying the
  // group-by rule verbatim to filters would refuse "gross takings for week 31".
  const compiled = compileSemanticQuery({
    topic: "sales_performance",
    metrics: ["commerce.gross_takings_inc_gst"],
    dimensions: [],
    filters: [{ field: "calendar_week", op: "gte", values: ["2026-07-27T00:00:00.000Z"] }],
    time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
    sort: [],
    limit: 20,
    parameters: {},
  } as never, registry, context);
  assert.ok(compiled.sql.includes("date_trunc"));
});

/**
 * The parameter-binding guard above compiles metrics with no filters, so it
 * could not see a filter branch that renders a predicate and then discards it.
 * Rendering binds a parameter, so a discarded predicate leaves a hole and
 * PostgreSQL rejects the whole statement with 42P18. Cover every operator on
 * both a labelled dimension and a derived time dimension.
 */
test("every filter operator binds a fully referenced parameter list", () => {
  const cases: readonly { field: string; op: string; values: unknown[] }[] = [
    { field: "product.category", op: "eq", values: ["Drivetrain"] },
    { field: "product.category", op: "neq", values: ["Drivetrain"] },
    { field: "product.category", op: "in", values: ["Drivetrain", "Wheels & Tyres"] },
    { field: "product.category", op: "not_in", values: ["Drivetrain"] },
    { field: "product.category", op: "is_null", values: [] },
    { field: "product.category", op: "is_not_null", values: [] },
    { field: "worker", op: "eq", values: ["Leigh Phillips"] },
    { field: "worker", op: "not_in", values: ["Leigh Phillips"] },
    { field: "business_date", op: "gte", values: ["2026-07-01"] },
    { field: "calendar_week", op: "gte", values: ["2026-07-20T00:00:00.000Z"] },
  ];

  const broken: string[] = [];
  for (const filter of cases) {
    const compiled = compileSemanticQuery({
      topic: "sales_performance",
      metrics: ["commerce.net_sales_ex_gst"],
      dimensions: [],
      filters: [filter],
      time: { field: "business_date", range: { type: "last_n_days", days: 30 }, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    } as never, registry, context);
    const used = boundParameters(compiled.sql);
    const expected = Array.from({ length: compiled.parameters.length }, (_, index) => index + 1);
    if (used.length !== expected.length || used.some((value, index) => value !== expected[index])) {
      broken.push(`${filter.field} ${filter.op}: supplied ${compiled.parameters.length}, referenced ${JSON.stringify(used)}`);
    }
  }
  assert.deepEqual(broken, [], `filters binding unreferenced parameters:\n${broken.join("\n")}`);
});

/**
 * The conversation runtime and the semantic service exchange the AGENT-shaped
 * tool input, not the normalised IR. Normalising before transport adds `kind`
 * and the trusted `parameters` key, and the service re-parses with the strict
 * agent-facing schema that forbids both — so every governed query was rejected
 * with 400 INVALID_REQUEST before it ran, and the chat could not answer a
 * single question while every layer beneath it worked.
 */
test("the agent-facing tool schema rejects a normalised IR, so the runtime must not send one", async () => {
  const { semanticToolInputSchemas, toolInputToSemanticQueryIr } =
    await import("../packages/agent/src/semantic-tools.js");

  const agentShaped = {
    topic: "sales_performance",
    metrics: ["gross_takings_inc_gst"],
    dimensions: ["location"],
    time: { field: "business_date", range: { type: "year_to_date" }, compare: "none" },
  };

  // What the model sends round-trips.
  const parsed = semanticToolInputSchemas.run_semantic_query.parse(agentShaped);
  assert.ok(semanticToolInputSchemas.run_semantic_query.safeParse(parsed).success);

  // The normalised IR does NOT — this is the asymmetry that broke the chat.
  const normalised = toolInputToSemanticQueryIr(parsed);
  assert.equal(semanticToolInputSchemas.run_semantic_query.safeParse(normalised).success, false);
});

test("live.ts sends the tool input over the semantic boundary, never the normalised IR", async () => {
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile("services/conversation/src/live.ts", "utf8"));
  assert.match(source, /semantic\.execute\("run_semantic_query", toolInput, context\)/u);
  assert.doesNotMatch(source, /semantic\.execute\("run_semantic_query", ir, context\)/u);
});

/**
 * "This year" is materially ambiguous for an Australian business: the financial
 * year opens 1 July, the calendar year 1 January. The compiler resolved it from
 * a hardcoded fiscal default of month 7 that no tenant had confirmed, so
 * "any sales this year?" reported five weeks of trade as the year to date.
 * The basis is now a confirmed tenant preference the agent must ask for.
 */
test("a confirmed year basis decides what year_to_date means", async () => {
  const { ALBERT_PREFERENCE_OPTION_IDS, resolveAlbertPreferenceOption, isAllowlistedRememberedPreference } =
    await import("../packages/agent/src/semantic-tools.js");

  // Both options exist and belong to one preference group, so ask_user can
  // offer them together.
  assert.ok(ALBERT_PREFERENCE_OPTION_IDS.includes("calendar.financial_year" as never));
  assert.ok(ALBERT_PREFERENCE_OPTION_IDS.includes("calendar.calendar_year" as never));
  const financial = resolveAlbertPreferenceOption("calendar.financial_year" as never);
  const calendar = resolveAlbertPreferenceOption("calendar.calendar_year" as never);
  assert.equal(financial.preference, "calendar.year_basis");
  assert.equal(calendar.preference, "calendar.year_basis");
  assert.ok(isAllowlistedRememberedPreference("calendar.year_basis", "financial_year"));
  assert.ok(isAllowlistedRememberedPreference("calendar.year_basis", "calendar_year"));
  assert.equal(isAllowlistedRememberedPreference("calendar.year_basis", "whenever"), false);

  // The two bases resolve to genuinely different windows, which is why
  // answering on an unconfirmed one misreports the period.
  const windowFor = (fiscalYearStartMonth: number) => {
    const compiled = compileSemanticQuery({
      topic: "sales_performance",
      metrics: ["commerce.gross_takings_inc_gst"],
      dimensions: [],
      filters: [],
      time: { field: "business_date", range: { type: "year_to_date" }, compare: "none" },
      sort: [],
      limit: 20,
      parameters: {},
    } as never, registry, { ...context, now: "2026-08-05T00:00:00.000Z", fiscalYearStartMonth } as never);
    return (compiled.resolvedTime as unknown as { fromBusinessDate: string }).fromBusinessDate;
  };
  assert.equal(windowFor(7), "2026-07-01");
  assert.equal(windowFor(1), "2026-01-01");
});

test("the agent is told to ask before answering a year-scoped question", async () => {
  const source = await import("node:fs/promises")
    .then((fs) => fs.readFile("services/conversation/src/live.ts", "utf8"));
  assert.match(source, /calendar\.financial_year \/ calendar\.calendar_year/u);
  assert.match(source, /no confirmed calendar\.year_basis/u);
});
