import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";

const root = path.resolve(import.meta.dirname, "../..");
const cubeDir = path.join(root, "cube-playground/model/cubes");
const viewDir = path.join(root, "cube-playground/model/views");
const queryDir = path.join(root, "cube-playground/agents/certified_queries");

type Named = Readonly<{ name: string; [key: string]: unknown }>;
type ModelDocument = Readonly<{ cubes?: readonly Named[]; views?: readonly Named[] }>;

function modelDocuments(directory: string): readonly ModelDocument[] {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => yaml.load(fs.readFileSync(path.join(directory, name), "utf8")) as ModelDocument);
}

const cubes = modelDocuments(cubeDir).flatMap((document) => document.cubes ?? []);
const views = modelDocuments(viewDir).flatMap((document) => document.views ?? []);

function cube(name: string): Named {
  const value = cubes.find((candidate) => candidate.name === name);
  assert.ok(value, `missing cube ${name}`);
  return value;
}

function view(name: string): Named {
  const value = views.find((candidate) => candidate.name === name);
  assert.ok(value, `missing view ${name}`);
  return value;
}

function members(container: Named, key: "dimensions" | "measures" | "segments"): readonly Named[] {
  return (container[key] as readonly Named[] | undefined) ?? [];
}

function member(container: Named, key: "dimensions" | "measures" | "segments", name: string): Named {
  const value = members(container, key).find((candidate) => candidate.name === name);
  assert.ok(value, `${container.name} is missing ${key.slice(0, -1)} ${name}`);
  return value;
}

function viewMembers(semanticView: Named): ReadonlySet<string> {
  const exposed = new Set<string>();
  for (const binding of (semanticView.cubes as readonly Record<string, unknown>[] | undefined) ?? []) {
    const terminalCube = String(binding.join_path).split(".").at(-1)!;
    const sourceCube = cube(terminalCube);
    const sourceMembers = new Set([
      ...members(sourceCube, "dimensions").map(({ name }) => name),
      ...members(sourceCube, "measures").map(({ name }) => name),
      ...members(sourceCube, "segments").map(({ name }) => name),
    ]);
    for (const include of (binding.includes as readonly (string | Record<string, unknown>)[] | undefined) ?? []) {
      const source = typeof include === "string" ? include : String(include.name);
      const alias = typeof include === "string" ? include : String(include.alias ?? include.name);
      assert.ok(sourceMembers.has(source), `${semanticView.name} exposes missing ${terminalCube}.${source}`);
      exposed.add(binding.prefix === true ? `${terminalCube}_${alias}` : alias);
    }
  }
  return exposed;
}

function certifiedQuery(name: string): Readonly<{ frontmatter: Record<string, unknown>; query: Record<string, unknown> }> {
  const source = fs.readFileSync(path.join(queryDir, `${name}.md`), "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1];
  const json = source.match(/```json\n([\s\S]*?)```/u)?.[1];
  assert.ok(frontmatter, `${name} has no frontmatter`);
  assert.ok(json, `${name} has no JSON query`);
  return {
    frontmatter: yaml.load(frontmatter) as Record<string, unknown>,
    query: JSON.parse(json) as Record<string, unknown>,
  };
}

test("R-Series customer lifetime SQL aggregates once and refunds never create repeat purchases", () => {
  const customers = cube("customers");
  const sql = String(customers.sql);

  assert.match(sql, /latest_customer_pack AS MATERIALIZED/iu);
  assert.match(sql, /latest_sales_pack AS MATERIALIZED/iu);
  assert.match(sql, /latest_customer_activity AS MATERIALIZED/iu);
  assert.match(sql, /ordered_positive_purchases AS MATERIALIZED/iu);
  assert.match(sql, /ROW_NUMBER\(\) OVER \([\s\S]*PARTITION BY sale\.tenant_id, sale\.customer_id[\s\S]*ORDER BY sale\.complete_time ASC NULLS LAST[\s\S]*sale\.sale_id ASC NULLS LAST[\s\S]*sale\.namespaced_source_key ASC/iu);
  assert.match(sql, /FROM latest_customer_activity sale\s+WHERE COALESCE\(sale\.calc_total, 0\) > 0/iu);
  assert.match(sql, /second_purchases AS MATERIALIZED/iu);
  assert.match(sql, /FILTER \(WHERE purchase\.purchase_sequence = 2\) AS second_purchase_at/iu);
  assert.match(sql, /lifetime AS MATERIALIZED/iu);
  assert.match(sql, /GROUP BY sale\.tenant_id, sale\.customer_id/iu);
  assert.match(sql, /MIN\(sale\.complete_time\) FILTER \(WHERE COALESCE\(sale\.calc_total, 0\) > 0\) AS first_purchase_at/iu);
  assert.match(sql, /MAX\(sale\.complete_time\) FILTER \(WHERE COALESCE\(sale\.calc_total, 0\) > 0\) AS last_purchase_at/iu);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE COALESCE\(sale\.calc_total, 0\) > 0\) AS purchase_count/iu);
  assert.match(sql, /COUNT\(\*\) FILTER \(WHERE COALESCE\(sale\.calc_total, 0\) < 0\) AS refund_count/iu);
  assert.match(sql, /SUM\(sale\.calc_total\).*AS lifetime_net_spend/isu);
  assert.match(sql, /SUM\(ABS\(sale\.calc_total\)\).*AS lifetime_refund_value/isu);

  for (const name of [
    "first_purchase_at", "second_purchase_at", "last_purchase_at", "days_to_second_purchase",
    "purchase_count", "refund_count",
    "lifetime_net_spend", "lifetime_purchase_value", "lifetime_refund_value",
  ]) {
    assert.equal(member(customers, "dimensions", name).sub_query, undefined, `${name} regressed to a correlated sub-query`);
  }
  assert.equal(member(customers, "dimensions", "lifetime_transactions").sql, "purchase_count");
  assert.match(String(member(customers, "dimensions", "is_repeat_customer").sql), /purchase_count[^>]*> 1/iu);
  assert.match(String(member(customers, "dimensions", "full_name").sql), /company/iu);
  assert.match(String(member(customers, "dimensions", "recency_band").sql), /30 days[\s\S]*90 days[\s\S]*180 days[\s\S]*365 days/iu);
  assert.match(String(member(customers, "dimensions", "frequency_band").sql), /1 purchase[\s\S]*2-4 purchases[\s\S]*5-9 purchases[\s\S]*10\+ purchases/iu);
  assert.match(String(member(customers, "dimensions", "is_lapsed_180_days").sql), /INTERVAL '180 days'/iu);

  const daysToSecond = String(member(customers, "dimensions", "days_to_second_purchase").sql);
  assert.match(daysToSecond, /second_purchase_at - \{CUBE\}\.first_purchase_at/iu);
  const mature = member(customers, "measures", "mature_90_day_customers");
  const repeated = member(customers, "measures", "repeated_within_90_days");
  assert.match(JSON.stringify(mature.filters), /first_purchase_at.*<= NOW\(\) - INTERVAL '90 days'/iu);
  const repeatedFilter = JSON.stringify(repeated.filters);
  assert.match(repeatedFilter, /first_purchase_at.*<= NOW\(\) - INTERVAL '90 days'/iu);
  assert.match(repeatedFilter, /second_purchase_at.*<=.*first_purchase_at \+ INTERVAL '90 days'/iu);
  assert.doesNotMatch(repeatedFilter, /calc_total|refund/iu, "the repeat milestone must come only from ordered positive purchases");
  assert.equal(
    String(member(customers, "measures", "repeat_within_90_days_pct").sql),
    "100.0 * {repeated_within_90_days} / NULLIF({mature_90_day_customers}, 0)",
  );

  const publicCustomers = viewMembers(view("customer_analytics"));
  for (const name of [
    "second_purchase_at", "days_to_second_purchase", "mature_90_day_customers",
    "repeated_within_90_days", "repeat_within_90_days_pct",
  ]) assert.ok(publicCustomers.has(name), `customer_analytics does not expose ${name}`);
});

test("identified and anonymous sales helpers are exact complements on one governed population", () => {
  const sales = cube("sales");
  const base = /completed = true AND COALESCE\(\{CUBE\}\.voided, false\) = false/iu;
  const identifiedTransactions = member(sales, "measures", "identified_transactions");
  const anonymousTransactions = member(sales, "measures", "anonymous_transactions");
  const identifiedRevenue = member(sales, "measures", "identified_gross_takings");
  const anonymousRevenue = member(sales, "measures", "anonymous_gross_takings");

  for (const measure of [identifiedTransactions, anonymousTransactions, identifiedRevenue, anonymousRevenue]) {
    const filter = JSON.stringify(measure.filters);
    assert.match(filter, base, `${measure.name} changed its completed/non-voided population`);
  }
  assert.match(JSON.stringify(identifiedTransactions.filters), /customer_id IS NOT NULL.*customer_id <> 0/iu);
  assert.match(JSON.stringify(anonymousTransactions.filters), /customer_id IS NULL OR.*customer_id = 0/iu);
  assert.match(JSON.stringify(identifiedRevenue.filters), /customer_id IS NOT NULL.*customer_id <> 0/iu);
  assert.match(JSON.stringify(anonymousRevenue.filters), /customer_id IS NULL OR.*customer_id = 0/iu);
  assert.equal(identifiedRevenue.sql, "calc_total");
  assert.equal(anonymousRevenue.sql, "calc_total");
  assert.match(String(member(sales, "measures", "identified_transaction_coverage_pct").sql), /identified_transactions.*transactions/iu);
  assert.match(String(member(sales, "measures", "anonymous_transaction_coverage_pct").sql), /anonymous_transactions.*transactions/iu);
  assert.match(String(member(sales, "measures", "identified_revenue_coverage_pct").sql), /identified_gross_takings.*gross_takings/iu);
  assert.match(JSON.stringify(member(sales, "measures", "purchasing_customers").filters), /calc_total[^>]*> 0/iu);

  const publicSales = viewMembers(view("sales_analytics"));
  for (const name of [
    "identified_transactions", "anonymous_transactions", "identified_transaction_coverage_pct",
    "anonymous_transaction_coverage_pct", "identified_gross_takings", "anonymous_gross_takings",
    "identified_revenue_coverage_pct", "anonymous_revenue_coverage_pct",
  ]) assert.ok(publicSales.has(name), `sales_analytics does not expose ${name}`);
});

test("ordinary R-Series customer-bearing views exclude direct PII and free-text customer values", () => {
  const customerMembers = viewMembers(view("customer_analytics"));
  const prohibitedCustomerMembers = [
    "customer_id", "date_of_birth", "contacts_address1", "contacts_address2",
    "contacts_primary_email", "contacts_primary_phone",
    "customer_custom_field_values_name", "customer_custom_field_values_value_text", "customer_notes_note",
    "customer_notes_noted_at",
  ];
  assert.deepEqual(prohibitedCustomerMembers.filter((name) => customerMembers.has(name)), []);
  for (const safe of [
    "full_name", "company", "contacts_city", "contacts_state_code", "contacts_postcode",
    "contacts_has_email", "contacts_no_email", "customer_custom_field_values_count",
    "customer_notes_note_count", "customer_notes_latest_note_at",
  ]) assert.ok(customerMembers.has(safe), `customer_analytics lost safe member ${safe}`);

  const prohibitedByView = new Map<string, readonly string[]>([
    ["sales_analytics", ["customers_customer_id"]],
    ["product_sales_analytics", ["customers_customer_id"]],
    ["workshop_analytics", ["customers_customer_id"]],
  ]);
  for (const [viewName, prohibited] of prohibitedByView) {
    const exposed = viewMembers(view(viewName));
    assert.deepEqual(prohibited.filter((name) => exposed.has(name)), [], `${viewName} exposes a customer source ID`);
  }

  assert.equal(member(cube("customers"), "dimensions", "customer_id").public, false);
  assert.equal(member(cube("customers"), "dimensions", "date_of_birth").public, false);
  assert.equal(cube("customer_notes").public, false);
  assert.equal(cube("customer_custom_field_values").public, false);
});

test("customer contactability is flattened onto contacts without a broken email-cube join", () => {
  const contacts = cube("contacts");
  const sql = String(contacts.sql);

  assert.match(sql, /email_flags AS MATERIALIZED/iu);
  assert.match(sql, /COUNT\(\*\) AS email_count/iu);
  assert.match(sql, /email_flags\.tenant_id = contact\.tenant_id/iu);
  assert.match(sql, /email_flags\.contact_id = contact\.contact_id/iu);
  assert.match(sql, /COALESCE\(email_flags\.email_count, 0\) AS safe_email_count/iu);
  assert.equal(member(contacts, "dimensions", "email_count").sql, "{CUBE}.safe_email_count");
  assert.equal(member(contacts, "dimensions", "email_count").sub_query, undefined);
  assert.match(String(member(contacts, "dimensions", "has_email").sql), /safe_email_count/iu);
  assert.doesNotMatch(String(member(contacts, "dimensions", "has_email").sql), /contact_emails/iu);
  assert.match(JSON.stringify(member(contacts, "measures", "contactable_by_email").filters), /safe_email_count/iu);
});

test("every R-Series customer starter is a valid single-view recipe over published members", () => {
  const starters = [
    "recipe-customer-count",
    "top-customers-lifetime",
    "profitability-by-customer",
    "recipe-customer-pulse",
    "recipe-lapsed-high-value-customers",
    "recipe-customer-geography-contactability",
    "recipe-customer-attribution-coverage",
    "recipe-customer-90-day-repeat-cohorts",
  ];

  for (const name of starters) {
    const { frontmatter, query } = certifiedQuery(name);
    assert.equal(frontmatter.recipe, true, `${name} is not a recipe`);
    assert.ok(["fact", "table", "list", "line", "bar"].includes(String(frontmatter.presentation)), `${name} has no valid presentation`);
    assert.ok(Array.isArray(frontmatter.matches) && frontmatter.matches.length >= 2, `${name} needs reviewed matching examples`);

    const references = JSON.stringify(query).match(/[a-z][a-z0-9_]*\.[a-z0-9_]+/gu) ?? [];
    assert.ok(references.length > 0, `${name} has no semantic members`);
    const viewNames = new Set(references.map((reference) => reference.split(".")[0]!));
    assert.equal(viewNames.size, 1, `${name} mixes semantic views or grains`);
    const viewName = [...viewNames][0]!;
    const published = viewMembers(view(viewName));
    for (const reference of references) {
      const memberName = reference.slice(viewName.length + 1);
      assert.ok(published.has(memberName), `${name} references missing ${reference}`);
    }
  }
});

test("the 90-day cohort starter is censored, bounded, single-view and non-causal", () => {
  const { frontmatter, query } = certifiedQuery("recipe-customer-90-day-repeat-cohorts");
  assert.equal(frontmatter.recipe, true);
  assert.equal(frontmatter.presentation, "line");
  const guidance = String(frontmatter.answer_hint);
  assert.match(guidance, /full 90-day observation window/iu);
  assert.match(guidance, /Refunds never count/iu);
  assert.match(guidance, /never causal/iu);

  assert.deepEqual(query.measures, [
    "customer_analytics.mature_90_day_customers",
    "customer_analytics.repeated_within_90_days",
    "customer_analytics.repeat_within_90_days_pct",
  ]);
  assert.deepEqual(query.timeDimensions, [{
    dimension: "customer_analytics.first_purchase_at",
    granularity: "month",
    dateRange: "last 36 months",
  }]);
  assert.deepEqual(query.filters, [{
    member: "customer_analytics.mature_90_day_customers",
    operator: "gt",
    values: ["0"],
  }]);
  assert.equal(query.limit, 36);
  assert.doesNotMatch(JSON.stringify(query), /email|phone|address|note|customer_id/iu);
});
