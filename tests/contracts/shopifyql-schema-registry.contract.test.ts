import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SHOPIFYQL_API_VERSION,
  SHOPIFYQL_SCHEMA_REGISTRY,
  indexShopifyQLSchemaRegistry,
  loadShopifyQLSchemaRegistry,
  shopifyQLField,
  shopifyQLMatchExpression,
  type ShopifyQLField,
} from "../../connectors/shopify/shopifyql-registry.js";

const registry = SHOPIFYQL_SCHEMA_REGISTRY;
const index = indexShopifyQLSchemaRegistry();

const DOCUMENTED_SCHEMAS = `
campaign_products
campaign_sales
campaign_sessions
chargebacks
customers
discounts
fees
fulfillments
gift_cards
global_searches
inventory
inventory_adjustment_history
inventory_by_location
inventory_shipments
inventory_transfers
low_engagement_product_recommendations
marketing_engagements
payment_attempts
payments
payouts
product_recommendation_conversions
profitability
returns
sales
sales_taxes
search_conversions
search_queries
searches
sessions
shipping_labels
shop_campaign_insights
shop_post_purchase_offers
shop_product_impressions
shopify_forms
store_credit_summaries
store_credit_transactions
subscriptions
web_performance
`.trim().split("\n");

const FROM_ONLY_SCHEMAS = [
  "collective_product_engagements",
  "shopify_tax_ca_country",
  "shopify_tax_ca_transactions",
];

function assertSortedUnique(values: readonly string[], context: string): void {
  const expected = [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  assert.deepEqual(values, expected, `${context} is not sorted and unique`);
}

function requiredField(schemaName: string, fieldName: string): ShopifyQLField {
  const resolved = shopifyQLField(index, schemaName, fieldName);
  assert.ok(resolved, `missing ShopifyQL field ${schemaName}.${fieldName}`);
  return resolved.field;
}

test("the committed registry is compact, deterministic, and pinned to official 2026-07 docs", async () => {
  assert.strictEqual(loadShopifyQLSchemaRegistry(), registry);
  assert.equal(registry.registryVersion, 1);
  assert.equal(registry.apiVersion, SHOPIFYQL_API_VERSION);
  assert.deepEqual(registry.source, {
    provider: "Shopify",
    api: "ShopifyQL",
    apiVersion: "2026-07",
    documentationRoot: "https://shopify.dev/docs/api/shopifyql/2026-07",
    adminGraphqlDocumentationRoot:
      "https://shopify.dev/docs/api/admin-graphql/2026-07",
    sourceDocuments: 54,
    registrySha256: registry.source.registrySha256,
  });
  assert.match(registry.source.registrySha256, /^[a-f0-9]{64}$/u);

  const schemaContent = {
    access: registry.access,
    schemaIndex: registry.schemaIndex,
    schemas: registry.schemas,
    undocumentedSchemas: registry.undocumentedSchemas,
    dataTypes: registry.dataTypes,
    syntax: registry.syntax,
  };
  assert.equal(
    createHash("sha256").update(JSON.stringify(schemaContent), "utf8").digest("hex"),
    registry.source.registrySha256,
  );

  const artifact = await readFile(
    new URL(
      "../../connectors/shopify/generated/shopifyql-2026-07.json",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(artifact, `${JSON.stringify(registry)}\n`, "registry is not compact canonical JSON");

  const htmlSources = [
    registry.schemaIndex.sourceUrl,
    registry.syntax.sourceUrl,
    registry.access.sourceUrl,
    ...registry.schemas.map(({ sourceUrl }) => sourceUrl),
    ...registry.syntax.documents.map(({ sourceUrl }) => sourceUrl),
  ];
  const markdownSources = [
    registry.schemaIndex.sourceMarkdownUrl,
    registry.syntax.sourceMarkdownUrl,
    registry.access.sourceMarkdownUrl,
    ...registry.schemas.map(({ sourceMarkdownUrl }) => sourceMarkdownUrl),
    ...registry.syntax.documents.map(({ sourceMarkdownUrl }) => sourceMarkdownUrl),
  ];
  assert.equal(new Set(htmlSources).size, 54);
  assert.equal(new Set(markdownSources).size, 54);
  assert.ok(htmlSources.every((url) => url.startsWith("https://shopify.dev/") && !url.includes("/latest/")));
  assert.ok(markdownSources.every((url) => url.startsWith("https://shopify.dev/") && url.endsWith(".md")));
});

test("the official schema index and the complete FROM inventory are represented without fabrication", () => {
  assert.deepEqual(registry.schemas.map(({ name }) => name), DOCUMENTED_SCHEMAS);
  assert.deepEqual(registry.undocumentedSchemas.map(({ name }) => name), FROM_ONLY_SCHEMAS);
  assert.equal(registry.schemas.length, 38, "official schema index page count changed");
  assert.equal(registry.undocumentedSchemas.length, 3, "official FROM-only count changed");
  assert.equal(index.schemasByName.size, 38);
  assert.equal(index.queryableSchemasByName.size, 41);

  for (const name of DOCUMENTED_SCHEMAS) {
    assert.equal(index.queryableSchemasByName.get(name)?.documentationStatus, "documented");
  }
  for (const name of FROM_ONLY_SCHEMAS) {
    const queryable = index.queryableSchemasByName.get(name);
    assert.equal(queryable?.documentationStatus, "from_only");
    assert.equal(index.schemasByName.has(name), false, `${name} must not gain invented fields`);
  }
});

test("all documented metrics, dimensions, types, deprecations, and MATCHES conditions are indexed", () => {
  const metrics = registry.schemas.flatMap(({ metrics }) => metrics);
  const dimensions = registry.schemas.flatMap(({ dimensions }) => dimensions);
  const fields = [...metrics, ...dimensions];
  const expressions = registry.schemas.flatMap(({ matches }) => matches);
  const conditions = registry.schemas.flatMap(({ matchConditions }) => matchConditions);
  const conditionFields = conditions.flatMap(({ fields }) => fields);

  assert.equal(registry.counts.schemas, registry.schemas.length);
  assert.equal(registry.counts.undocumentedSchemas, registry.undocumentedSchemas.length);
  assert.equal(registry.counts.domains, registry.schemaIndex.domains.length);
  assert.equal(registry.counts.metrics, metrics.length);
  assert.equal(registry.counts.dimensions, dimensions.length);
  assert.equal(registry.counts.fields, fields.length);
  assert.equal(registry.counts.deprecatedMetrics, metrics.filter(({ isDeprecated }) => isDeprecated).length);
  assert.equal(registry.counts.deprecatedDimensions, dimensions.filter(({ isDeprecated }) => isDeprecated).length);
  assert.equal(registry.counts.formulas, fields.filter(({ formula }) => formula).length);
  assert.equal(registry.counts.dataTypes, registry.dataTypes.length);
  assert.equal(registry.counts.matchExpressions, expressions.length);
  assert.equal(registry.counts.matchConditionTypes, conditions.length);
  assert.equal(registry.counts.matchConditionFields, conditionFields.length);
  assert.equal(
    registry.counts.queryableMetafieldPatterns,
    registry.schemas.flatMap(({ queryableMetafieldPatterns }) => queryableMetafieldPatterns).length,
  );
  assert.equal(
    registry.counts.relatedSchemaLinks,
    registry.schemas.flatMap(({ relatedSchemas }) => relatedSchemas).length,
  );

  assert.deepEqual(registry.counts, {
    sourceDocuments: 54,
    schemas: 38,
    undocumentedSchemas: 3,
    domains: 7,
    metrics: 349,
    dimensions: 1978,
    fields: 2327,
    deprecatedMetrics: 17,
    deprecatedDimensions: 7,
    formulas: 71,
    dataTypes: 29,
    matchExpressions: 62,
    matchConditionTypes: 62,
    matchConditionFields: 211,
    queryableMetafieldPatterns: 5,
    relatedSchemaLinks: 96,
    syntaxDocuments: 13,
    clauses: 13,
    expressionOperators: 4,
    whereOperators: 23,
    havingOperators: 23,
    whereFunctions: 1,
    matchOperators: 2,
    timeseriesDimensions: 12,
    namedDateRanges: 14,
    dateFunctions: 7,
    relativeComparisons: 10,
    modifiers: 7,
    attributionModels: 5,
    visualizationTypes: 25,
    annotationTypes: 57,
  });

  assertSortedUnique(registry.schemas.map(({ name }) => name), "schemas");
  assertSortedUnique(registry.dataTypes.map(({ name }) => name), "data types");
  for (const schema of registry.schemas) {
    assert.ok(schema.description.length > 0);
    assert.ok(schema.metrics.length > 0, `${schema.name} has no metrics`);
    assert.ok(schema.dimensions.length > 0, `${schema.name} has no dimensions`);
    assertSortedUnique(schema.metrics.map(({ name }) => name), `${schema.name}.metrics`);
    assertSortedUnique(schema.dimensions.map(({ name }) => name), `${schema.name}.dimensions`);
    assertSortedUnique(schema.matches.map(({ name }) => name), `${schema.name}.matches`);
    assertSortedUnique(
      schema.matchConditions.map(({ name }) => name),
      `${schema.name}.matchConditions`,
    );
    assertSortedUnique(schema.queryableMetafieldPatterns, `${schema.name}.metafields`);
    assertSortedUnique(schema.relatedSchemas, `${schema.name}.relatedSchemas`);
    for (const related of schema.relatedSchemas) {
      assert.ok(index.queryableSchemasByName.has(related), `${schema.name} points to ${related}`);
    }
    const schemaIndex = index.schemasByName.get(schema.name);
    assert.ok(schemaIndex);
    for (const field of [...schema.metrics, ...schema.dimensions]) {
      const baseType = /^ARRAY<(.+)>$/u.exec(field.type)?.[1] ?? field.type;
      assert.ok(index.dataTypesByName.has(baseType), `${schema.name}.${field.name}: ${field.type}`);
      assert.ok(field.description.length > 0);
      if (field.isDeprecated) assert.ok(field.deprecationReason);
      else assert.equal(field.deprecationReason, undefined);
      assert.ok(shopifyQLField(index, schema.name, field.name));
    }
    for (const expression of schema.matches) {
      const resolved = shopifyQLMatchExpression(index, schema.name, expression.name);
      assert.ok(resolved);
      assert.equal(resolved.condition.name, expression.type);
    }
    for (const condition of schema.matchConditions) {
      assert.ok(condition.description.length > 0);
      assertSortedUnique(condition.fields.map(({ name }) => name), `${condition.name}.fields`);
      for (const field of condition.fields) {
        assert.ok(field.role === "filter" || field.role === "metric");
        assert.ok(index.dataTypesByName.has(field.type), `${condition.name}.${field.name}`);
      }
    }
  }
});

test("every documented syntax capability and condition family is planner-addressable", () => {
  assert.deepEqual(
    registry.syntax.documents.map(({ slug }) => slug),
    [
      "annotate",
      "comments",
      "compare-to",
      "from-and-show",
      "group-by",
      "having",
      "limit",
      "order-by",
      "since-until-during",
      "timeseries",
      "visualize",
      "where",
      "with",
    ],
  );
  assert.deepEqual(
    registry.syntax.clauses.map(({ name }) => name),
    [
      "FROM",
      "SHOW",
      "WHERE",
      "GROUP BY",
      "TIMESERIES",
      "WITH",
      "HAVING",
      "SINCE, UNTIL, DURING",
      "COMPARE TO",
      "ORDER BY",
      "LIMIT",
      "VISUALIZE",
      "ANNOTATE",
    ],
  );
  assert.ok(registry.syntax.documents.every(({ grammar }) => grammar.length > 0));
  assert.deepEqual(registry.syntax.expressionOperators.map(({ syntax }) => syntax), ["+", "/", "*", "-"]);
  assert.deepEqual(registry.syntax.whereOperators, registry.syntax.havingOperators);
  assert.deepEqual(
    registry.syntax.whereOperators.map(({ name }) => name),
    [
      "AND", "BETWEEN", "CONTAINS", "ENDS WITH", "IN", "IS FALSE", "IS NOT FALSE",
      "IS NOT NULL", "IS NOT TRUE", "IS NULL", "IS TRUE", "NOT", "NOT BETWEEN",
      "NOT CONTAINS", "NOT IN", "OR", "STARTS WITH", "equals", "greater than",
      "greater than or equal", "less than", "less than or equal", "not equals",
    ],
  );
  assert.deepEqual(registry.syntax.whereFunctions[0]?.supportedOperators, ["=", "!=", "BETWEEN"]);
  assert.deepEqual(registry.syntax.matchOperators.map(({ name }) => name), ["MATCHES", "NOT MATCHES"]);
  assert.deepEqual(
    registry.syntax.timeseries.map(({ name }) => name),
    [
      "second", "minute", "hour", "day", "week", "month", "quarter", "year",
      "hour_of_day", "day_of_week", "week_of_year", "month_of_year",
    ],
  );
  assert.equal(registry.syntax.namedDateRanges.length, 14);
  assert.equal(registry.syntax.dateFunctions.length, 7);
  assert.equal(registry.syntax.relativeComparisons.length, 10);
  assert.equal(registry.syntax.modifiers.length, 7);
  assert.deepEqual(
    registry.syntax.attributionModels.map(({ name }) => name),
    [
      "FIRST_CLICK_ATTRIBUTION",
      "LAST_CLICK_ATTRIBUTION",
      "LAST_NON_DIRECT_CLICK_ATTRIBUTION",
      "ANY_CLICK_ATTRIBUTION",
      "LINEAR_ATTRIBUTION",
    ],
  );
  assert.equal(registry.syntax.visualizationTypes.length, 25);
  assert.equal(registry.syntax.annotationTypes.length, 57);
  assert.ok(registry.syntax.annotationTypes.some(({ category, type }) =>
    category === "product_events" && type === "product_unpublished"));
});

test("the index resolves representative world-class commerce questions at their official semantics", () => {
  assert.equal(requiredField("sales", "gross_sales").type, "MONEY");
  assert.equal(
    requiredField("sales", "net_sales").formula,
    "Net sales = gross sales - discounts - sales reversals",
  );
  assert.equal(
    requiredField("sales", "total_sales").formula,
    "Total sales = net sales + additional fees + duties + shipping charges + taxes",
  );
  assert.match(requiredField("sales", "order_checkout_currency").description, /buyer saw at checkout/u);
  assert.match(requiredField("sales", "order_payment_status").description, /payment state/u);
  assert.match(requiredField("sales", "order_fulfillment_status").description, /fulfillment state/u);
  assert.equal(requiredField("returns", "returned_quantity").type, "INTEGER");
  assert.equal(requiredField("fulfillments", "orders_fulfilled").type, "INTEGER");
  assert.equal(requiredField("inventory", "ending_inventory_units").type, "INTEGER");
  assert.equal(requiredField("customers", "total_amount_spent").type, "MONEY");
  assert.equal(requiredField("payments", "net_payments").type, "MONEY");
  assert.equal(requiredField("payouts", "payout_amount").type, "MONEY");
  assert.equal(requiredField("subscriptions", "active_subscriptions").type, "INTEGER");
  assert.equal(requiredField("gift_cards", "ending_gift_card_balance").type, "MONEY");
  assert.equal(requiredField("sessions", "conversion_rate").type, "PERCENT");
  assert.equal(requiredField("campaign_sales", "campaign_last_click_sales").isDeprecated, true);
  assert.match(
    requiredField("campaign_sales", "campaign_last_click_sales").deprecationReason ?? "",
    /campaign_last_click_total_sales/u,
  );
  assert.equal(shopifyQLField(index, "sales", "not_a_shopify_field"), undefined);
  assert.equal(shopifyQLField(index, "shopify_tax_ca_country", "taxes"), undefined);
  assert.ok(shopifyQLMatchExpression(index, "customers", "orders_placed"));
  assert.ok(shopifyQLMatchExpression(index, "sales", "customer.products_purchased"));
  const distance = shopifyQLMatchExpression(index, "customers", "within_distance");
  assert.deepEqual(
    distance?.condition.fields.map(({ name }) => name),
    ["coordinates", "distance_km", "distance_mi"],
    "escaped underscores in official Markdown must not drop required radius fields",
  );
  assert.equal(registry.access.requiredScope, "read_reports");
  assert.equal(registry.access.protectedCustomerDataLevel, 2);
});
