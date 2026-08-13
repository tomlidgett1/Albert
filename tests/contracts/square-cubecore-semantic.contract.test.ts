import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

import {
  SQUARE_CURRENCY_EXPONENT_0,
  SQUARE_CURRENCY_EXPONENT_2,
  SQUARE_CURRENCY_EXPONENT_3,
  SQUARE_CURRENCY_EXPONENT_4,
} from "../../connectors/square/currency.js";

const root = path.resolve(import.meta.dirname, "../..");
const cubeDir = path.join(root, "cube-playground/model/cubes");
const viewDir = path.join(root, "cube-playground/model/views");
const agentsDir = path.join(root, "cube-playground/agents");
const currencyMigration = fs.readFileSync(
  path.join(root, "infra/migrations/analytical/0148_m3_square_currency_base_units.sql"),
  "utf8",
);

type Named = Readonly<{ name: string; [key: string]: unknown }>;
type ModelDocument = Readonly<{ cubes?: readonly Named[]; views?: readonly Named[] }>;

function modelDocuments(dir: string): readonly ModelDocument[] {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => yaml.load(fs.readFileSync(path.join(dir, name), "utf8")) as ModelDocument);
}

const cubes = modelDocuments(cubeDir).flatMap((document) => document.cubes ?? []);
const views = modelDocuments(viewDir).flatMap((document) => document.views ?? []);
const squareCubes = cubes.filter((cube) => cube.name.startsWith("square_"));
const squareViews = views.filter((view) => view.name.startsWith("square_"));

function memberNames(container: Named, key: "dimensions" | "measures"): readonly string[] {
  return ((container[key] as readonly Named[] | undefined) ?? []).map((member) => member.name);
}

function cube(name: string): Named {
  const value = squareCubes.find((candidate) => candidate.name === name);
  assert.ok(value, `missing Square cube ${name}`);
  return value;
}

function view(name: string): Named {
  const value = squareViews.find((candidate) => candidate.name === name);
  assert.ok(value, `missing Square view ${name}`);
  return value;
}

function viewMembers(value: Named): ReadonlySet<string> {
  const members = new Set<string>();
  for (const binding of (value.cubes as readonly Record<string, unknown>[] | undefined) ?? []) {
    const terminalCube = String(binding.join_path).split(".").at(-1)!;
    const prefixed = binding.prefix === true;
    for (const include of (binding.includes as readonly (string | Record<string, unknown>)[] | undefined) ?? []) {
      const source = typeof include === "string" ? include : String(include.name);
      const exposed = typeof include === "string" ? include : String(include.alias ?? include.name);
      members.add(prefixed ? `${terminalCube}_${exposed}` : exposed);
      assert.ok(memberNames(cube(terminalCube), "dimensions").includes(source) || memberNames(cube(terminalCube), "measures").includes(source),
        `${value.name} exposes missing ${terminalCube}.${source}`);
    }
  }
  return members;
}

test("Square CubeCore publishes curated native-grain domains plus an exhaustive field fallback", () => {
  const expected = [
    "square_sales_analytics",
    "square_product_sales_analytics",
    "square_payments_analytics",
    "square_refunds_analytics",
    "square_disputes_analytics",
    "square_settlements_analytics",
    "square_inventory_analytics",
    "square_inventory_activity_analytics",
    "square_workforce_analytics",
    "square_labour_sales_analytics",
    "square_cash_management_analytics",
    "square_cash_activity_analytics",
    "square_loyalty_analytics",
    "square_loyalty_activity_analytics",
    "square_gift_card_analytics",
    "square_gift_card_activity_analytics",
    "square_catalogue_analytics",
    "square_customer_analytics",
    "square_source_explorer",
  ];
  assert.deepEqual(expected.filter((name) => !squareViews.some((candidate) => candidate.name === name)), []);
  for (const semanticView of squareViews) {
    const description = String(semanticView.description ?? "").trim();
    const meta = semanticView.meta as Record<string, unknown> | undefined;
    assert.ok(description.length >= 50, `${semanticView.name} needs a business description`);
    assert.ok(String(meta?.ai_context ?? "").trim().length >= 80, `${semanticView.name} needs substantive AI context`);
    assert.ok(viewMembers(semanticView).size > 0, `${semanticView.name} must expose members`);
  }
});

test("the exhaustive Square explorer exposes stable identity and every typed value channel", () => {
  const explorer = cube("square_source_fields");
  assert.match(String(explorer.sql), /source_square\.sq_source_fields/u);
  assert.deepEqual(
    [
      "parent_stream", "source_object_type", "source_record_id", "field_path",
      "field_ordinal_path", "field_name", "value_type", "string_value",
      "number_value", "boolean_value", "timestamp_value", "date_value",
      "json_value", "money_amount_minor", "money_currency",
    ].filter((name) => !memberNames(explorer, "dimensions").includes(name)),
    [],
  );
  assert.deepEqual(
    ["field_occurrences", "source_records", "numeric_value_sum", "numeric_value_average", "numeric_value_minimum", "numeric_value_maximum"]
      .filter((name) => !memberNames(explorer, "measures").includes(name)),
    [],
  );
  assert.match(JSON.stringify(explorer.meta), /every field_index entry/iu);
  assert.match(String((view("square_source_explorer").meta as Record<string, unknown>).ai_context), /exact field_path/iu);
});

test("curated Square cubes depend only on guaranteed payload_json roots and exact physical stream names", () => {
  const modelText = fs.readdirSync(cubeDir)
    .filter((name) => name.startsWith("square_") && name.endsWith(".yml"))
    .map((name) => fs.readFileSync(path.join(cubeDir, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(modelText.replaceAll("source_square.sq_source_fields", ""), /source_square\.sq_/u);
  for (const table of [
    "square_orders", "square_locations", "square_customers", "square_catalog_objects",
    "square_payments", "square_refunds", "square_disputes", "square_payouts", "square_payout_entries", "square_inventory_counts",
    "square_inventory_changes", "square_team_members", "square_timecards",
    "square_cash_drawer_shifts", "square_cash_drawer_shift_events", "square_loyalty_accounts", "square_loyalty_events",
    "square_gift_cards", "square_gift_card_activities",
  ]) {
    assert.match(modelText, new RegExp(`source_square\\.${table}\\b`, "u"), `missing physical Square stream ${table}`);
  }
  assert.match(modelText, /payload_json/gu);
  assert.doesNotMatch(modelText, /source_square\.square_payment\b/u);
});

test("every Square semantic join is connection-scoped and aggregate keys keep stores separate", () => {
  for (const semanticCube of squareCubes) {
    const sql = String(semanticCube.sql ?? "");
    const dimensions = memberNames(semanticCube, "dimensions");
    assert.ok(dimensions.includes("connection_id"), `${semanticCube.name} must retain connection_id`);
    if (semanticCube.name !== "square_source_fields") {
      assert.match(sql, /connection_id/u, `${semanticCube.name} SQL must project connection_id`);
    }
    for (const join of (semanticCube.joins as readonly Record<string, unknown>[] | undefined) ?? []) {
      assert.match(
        String(join.sql ?? ""),
        /connection_id/u,
        `${semanticCube.name} -> ${String(join.name)} must join within one Square connection`,
      );
    }
  }

  const orderLines = String(cube("square_order_lines").sql);
  for (const alias of ["variation", "item", "category"]) {
    assert.match(orderLines, new RegExp(`${alias}\\.connection_id = t\\.connection_id`, "u"));
  }
  const embeddedModel = fs.readdirSync(cubeDir)
    .filter((name) => name.startsWith("square_") && name.endsWith(".yml"))
    .map((name) => fs.readFileSync(path.join(cubeDir, name), "utf8"))
    .join("\n");
  const embeddedJoin = /(?:LEFT|RIGHT|FULL|INNER)?\s*JOIN\s+source_square\.[a-z_]+[\s\S]*?\bON\b([\s\S]*?)(?=\b(?:LEFT|RIGHT|FULL|INNER)?\s*JOIN\b|\bWHERE\b|\bGROUP BY\b)/giu;
  for (const match of embeddedModel.matchAll(embeddedJoin)) {
    const clause = match[1] ?? "";
    assert.match(clause, /connection_id/u, `embedded source_square join must be connection-scoped: ${clause.slice(0, 160)}`);
  }
  const efficiency = String(cube("square_daily_labour_sales").sql);
  assert.match(efficiency, /CONCAT\([\s\S]*?connection_id[\s\S]*?\) AS row_key/iu);
  assert.match(efficiency, /l\.connection_id = s\.connection_id/u);
});

test("Square local business dates require the connection's valid location timezone", () => {
  const efficiency = String(cube("square_daily_labour_sales").sql);
  assert.match(efficiency, /JOIN pg_timezone_names/iu);
  assert.match(efficiency, /location\.connection_id = orders\.connection_id/u);
  assert.match(efficiency, /location\.connection_id = t\.connection_id/u);
  assert.match(efficiency, /AT TIME ZONE location\.timezone_name/iu);
  assert.match(efficiency, /AT TIME ZONE timezone_name/iu);
  assert.doesNotMatch(efficiency, /COALESCE\([^)]*timezone[^)]*UTC|::timestamptz::date/iu);
});

test("Square labour hours use one connection-scoped currency without inventing wages", () => {
  const efficiency = String(cube("square_daily_labour_sales").sql);
  assert.match(efficiency, /location\.payload_json->>'currency' AS location_currency/u);
  assert.match(
    efficiency,
    /COALESCE\(payload_json#>> ARRAY\['wage', 'hourly_rate', 'currency'\], location_currency\) AS currency/u,
  );
  assert.match(
    efficiency,
    /COUNT\(\*\) FILTER \([\s\S]*?ARRAY\['wage', 'hourly_rate', 'amount'\][\s\S]*?> 0 THEN NULL/iu,
  );
  assert.match(efficiency, /CASE WHEN l\.tenant_id IS NULL THEN 0::numeric ELSE l\.estimated_labour_cost END/iu);
  assert.doesNotMatch(efficiency, /COALESCE\(l\.estimated_labour_cost,\s*0\)/iu);
  assert.doesNotMatch(efficiency, /CROSS JOIN[\s\S]*currency/iu);

  const moneyRule = fs.readFileSync(
    path.join(agentsDir, "rules/square-money-state-and-routing.md"),
    "utf8",
  );
  assert.match(moneyRule, /without a wage currency[\s\S]*grouped once[\s\S]*Square Location currency/iu);
  assert.match(moneyRule, /does not create an estimated[\s\S]*cost[\s\S]*wage amount itself is absent/iu);
  assert.match(moneyRule, /estimated labour cost is null rather than a misleading partial sum/iu);
});

test("Square curated Money scaling is centralized, authoritative and fail-closed", () => {
  const allSquare = squareCubes.map((value) => JSON.stringify(value)).join("\n");
  const powers = allSquare.match(/POWER\(10::numeric/gu) ?? [];
  const governedPowers = allSquare.match(
    /POWER\(10::numeric,\s*source_square\.square_currency_exponent\(/gu,
  ) ?? [];
  assert.ok(powers.length >= 30, "expected broad curated Square Money coverage");
  assert.equal(governedPowers.length, powers.length, "every base-unit conversion must use the governed helper");
  assert.doesNotMatch(allSquare, /POWER\(10::numeric,\s*CASE|ELSE 2 END/iu);

  assert.match(currencyMigration, /CREATE OR REPLACE FUNCTION source_square\.square_currency_exponent\(currency_code text\)/u);
  assert.match(currencyMigration, /IMMUTABLE[\s\S]*STRICT[\s\S]*PARALLEL SAFE[\s\S]*SECURITY INVOKER/u);
  assert.match(currencyMigration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/u);
  for (const role of ["transform_rw", "diagnostic_ro", "semantic_ro"]) {
    assert.match(currencyMigration, new RegExp(`GRANT EXECUTE[\\s\\S]*${role}`, "u"));
  }
  for (const evidence of [
    "developer.squareup.com/docs/build-basics/common-data-types/working-with-monetary-amounts",
    "developer.squareup.com/reference/square/enums/Currency",
    "six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml",
    "'JPY'", "'UYI'", "'USD'", "'KWD'", "'CLF'",
  ]) assert.ok(currencyMigration.includes(evidence), `currency contract lacks ${evidence}`);

  const functionBody = currencyMigration.match(/AS \$\$([\s\S]*?)\$\$;/u)?.[1] ?? "";
  assert.match(functionBody, /ELSE NULL::smallint/u);
  for (const unsupported of ["UNKNOWN_CURRENCY", "XAU", "XTS", "XXX", "BTC", "XUS"]) {
    assert.doesNotMatch(functionBody, new RegExp(`'${unsupported}'`, "u"));
  }

  const runtimeMappings = new Map<string, number>([
    ...SQUARE_CURRENCY_EXPONENT_0.map((currency) => [currency, 0] as const),
    ...SQUARE_CURRENCY_EXPONENT_2.map((currency) => [currency, 2] as const),
    ...SQUARE_CURRENCY_EXPONENT_3.map((currency) => [currency, 3] as const),
    ...SQUARE_CURRENCY_EXPONENT_4.map((currency) => [currency, 4] as const),
  ]);
  const declaredCurrencyCount = SQUARE_CURRENCY_EXPONENT_0.length + SQUARE_CURRENCY_EXPONENT_2.length
    + SQUARE_CURRENCY_EXPONENT_3.length + SQUARE_CURRENCY_EXPONENT_4.length;
  assert.equal(runtimeMappings.size, declaredCurrencyCount, "currency exponent groups overlap");
  assert.equal(runtimeMappings.size, 156, "pinned ISO/Square intersection changed without review");

  const sqlMappings = new Map<string, number>();
  for (const match of functionBody.matchAll(/WHEN currency_code IN \(([\s\S]*?)\)\s+THEN (\d)::smallint/gu)) {
    for (const code of match[1].matchAll(/'([^']+)'/gu)) sqlMappings.set(code[1], Number(match[2]));
  }
  for (const match of functionBody.matchAll(/WHEN currency_code = '([^']+)' THEN (\d)::smallint/gu)) {
    sqlMappings.set(match[1], Number(match[2]));
  }
  assert.deepEqual(
    [...sqlMappings].sort(([left], [right]) => left.localeCompare(right)),
    [...runtimeMappings].sort(([left], [right]) => left.localeCompare(right)),
    "canonical and Cube currency exponents diverge",
  );
});

test("Square measures preserve lifecycle, money, grain and canonical settlement invariants", () => {
  const allSquare = squareCubes.map((value) => JSON.stringify(value)).join("\n");
  const orders = JSON.stringify(cube("square_orders"));
  const lines = JSON.stringify(cube("square_order_lines"));
  const payments = JSON.stringify(cube("square_payments"));
  const refunds = JSON.stringify(cube("square_refunds"));
  const payouts = JSON.stringify(cube("square_payouts"));
  const labour = JSON.stringify(cube("square_daily_labour_sales"));

  assert.match(orders, /state.*COMPLETED|COMPLETED.*state/u);
  assert.match(orders, /net_amounts.*total_money/u);
  assert.match(lines, /jsonb_array_elements.*line_items/u);
  assert.match(lines, /GIFT_CARD/u);
  assert.match(payments, /status.*COMPLETED|COMPLETED.*status/u);
  assert.match(refunds, /PaymentRefund/u);
  assert.match(payouts, /settlement transfer/u);
  assert.doesNotMatch(allSquare, /finance_bank_transaction|bank-feed revenue/iu);
  assert.match(labour, /FULL OUTER JOIN/u);
  assert.match(labour, /sales_by_day/u);
  assert.match(labour, /labour_by_day/u);

  for (const currency of ["JPY", "KWD", "CLF"]) assert.match(currencyMigration, new RegExp(currency, "u"));
  assert.match(allSquare, /POWER\(10::numeric/iu);
});

test("every Square certified query references a real member of one accessible Square view", () => {
  const config = yaml.load(fs.readFileSync(path.join(agentsDir, "config.yml"), "utf8")) as {
    accessible_views: readonly { name: string; connector: string; guidance: string }[];
  };
  const accessible = new Set(config.accessible_views.filter((entry) => entry.connector === "square").map((entry) => entry.name));
  for (const semanticView of squareViews) assert.ok(accessible.has(semanticView.name), `${semanticView.name} is not accessible`);

  const files = fs.readdirSync(path.join(agentsDir, "certified_queries"))
    .filter((name) => name.startsWith("square-") && name.endsWith(".md"));
  assert.ok(files.length >= 10, "Square needs a broad certified-query set");
  for (const file of files) {
    const body = fs.readFileSync(path.join(agentsDir, "certified_queries", file), "utf8");
    const match = body.match(/```json\n([\s\S]*?)```/u);
    assert.ok(match, `${file} lacks a JSON query`);
    const query = JSON.parse(match[1]) as Record<string, unknown>;
    const references = JSON.stringify(query).match(/square_[a-z_]+\.[a-z_]+/gu) ?? [];
    assert.ok(references.length > 0, `${file} has no Square members`);
    const names = new Set(references.map((reference) => reference.split(".")[0]));
    assert.equal(names.size, 1, `${file} mixes semantic views`);
    const semanticViewName = [...names][0];
    assert.ok(accessible.has(semanticViewName), `${file} uses inaccessible ${semanticViewName}`);
    const members = viewMembers(view(semanticViewName));
    for (const reference of references) {
      const member = reference.slice(semanticViewName.length + 1);
      assert.ok(members.has(member), `${file} references missing ${reference}`);
    }
  }
});

test("Square certified money queries always separate currencies", () => {
  const files = fs.readdirSync(path.join(agentsDir, "certified_queries"))
    .filter((name) => name.startsWith("square-") && name.endsWith(".md"));
  const moneyMeasure = /(?:^|_)(?:amount|sales|value|fees|cost|variance|balance)(?:_|$)/u;
  for (const file of files) {
    const body = fs.readFileSync(path.join(agentsDir, "certified_queries", file), "utf8");
    const match = body.match(/```json\n([\s\S]*?)```/u);
    assert.ok(match, `${file} lacks a JSON query`);
    const query = JSON.parse(match[1]) as {
      measures?: readonly string[];
      dimensions?: readonly string[];
      filters?: readonly Record<string, unknown>[];
    };
    if (!(query.measures ?? []).some((measure) => moneyMeasure.test(measure))) continue;
    const queryMembers = [...(query.dimensions ?? []), JSON.stringify(query.filters ?? [])];
    const expectedCurrencySuffix = (query.measures ?? []).some((measure) =>
      measure.includes(".square_payment_fees_"))
      ? "square_payment_fees_currency"
      : (query.measures ?? []).some((measure) => measure.includes(".square_payout_entries_"))
        ? "square_payout_entries_currency"
        : "currency";
    assert.ok(
      queryMembers.some((member) => member.includes(expectedCurrencySuffix)),
      `${file} aggregates money without its same-grain ${expectedCurrencySuffix}`,
    );
  }
  const moneyRule = fs.readFileSync(
    path.join(agentsDir, "rules/square-money-state-and-routing.md"),
    "utf8",
  );
  assert.match(moneyRule, /filter to one same-grain currency member or include that member/iu);
  assert.match(moneyRule, /square_payment_fees_currency[\s\S]*square_payout_entries_currency/iu);
});

test("Square guidance covers arbitrary fields, PII, cafe/retail operations and no automatic ingestion claim", () => {
  const configText = fs.readFileSync(path.join(agentsDir, "config.yml"), "utf8");
  const ruleText = fs.readdirSync(path.join(agentsDir, "rules"))
    .filter((name) => name.startsWith("square-"))
    .map((name) => fs.readFileSync(path.join(agentsDir, "rules", name), "utf8"))
    .join("\n");
  const readme = fs.readFileSync(path.join(root, "connectors/square/README.md"), "utf8");
  for (const concept of ["processing", "refund", "inventory", "labour", "cash", "payout", "loyalty", "field_path", "PII"]) {
    assert.match(`${configText}\n${ruleText}`, new RegExp(concept, "iu"), `missing Square guidance for ${concept}`);
  }
  assert.match(readme, /must explicitly start the initial import/iu);
  assert.match(readme, /sq_source_fields/u);
});
