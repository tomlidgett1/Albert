import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import yaml from "js-yaml";

import {
  SHOPIFY_STREAM_FIELDS,
  SHOPIFY_STREAM_IDS,
  type ShopifyStreamId,
} from "../../connectors/shopify/streams.js";
import { SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY } from "../../connectors/shopify/schema-registry.js";

type CubeDocument = Readonly<{ cubes?: readonly Readonly<Record<string, unknown>>[] }>;
type ViewDocument = Readonly<{ views?: readonly Readonly<Record<string, unknown>>[] }>;
type AgentConfig = Readonly<{
  accessible_views?: readonly Readonly<{ name?: string; connector?: string }>[];
}>;

const cubeFiles = [
  new URL("../../cube-playground/model/cubes/shopify_reference.yml", import.meta.url),
  new URL("../../cube-playground/model/cubes/shopify_commerce.yml", import.meta.url),
];
const viewFile = new URL(
  "../../cube-playground/model/views/shopify_analytics.yml",
  import.meta.url,
);
const configFile = new URL("../../cube-playground/agents/config.yml", import.meta.url);
const stagingMigrationFile = new URL(
  "../../infra/migrations/analytical/0138_m2_shopify_full_staging.sql",
  import.meta.url,
);

function snakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

async function loadYaml<T>(url: URL): Promise<T> {
  return yaml.load(await readFile(url, "utf8")) as T;
}

test("every normalized Shopify stream has a private Cube projection", async () => {
  const documents = await Promise.all(cubeFiles.map((file) => loadYaml<CubeDocument>(file)));
  const cubes = documents.flatMap(({ cubes = [] }) => cubes);
  const byName = new Map(cubes.map((cube) => [String(cube.name), cube]));

  assert.deepEqual([...byName.keys()].sort(), [...SHOPIFY_STREAM_IDS].sort());
  for (const stream of SHOPIFY_STREAM_IDS) {
    const cube = byName.get(stream);
    assert.ok(cube, `missing Cube for ${stream}`);
    assert.equal(cube.public, false, `${stream} must remain private`);
    assert.match(String(cube.sql), new RegExp(`source_shopify\\.${stream}\\b`, "u"));
    assert.match(String(cube.sql), /WHERE NOT t\.tombstone/u);
    assert.doesNotMatch(String(cube.sql), /\bmapping_version\b/u);

    // Cube 1.7 rejects measures that directly interpolate a joined cube. Any
    // joined value used in a measure must first be projected at this cube's
    // grain, otherwise static member resolution can pass while `/v1/meta`
    // fails schema compilation in production.
    for (const measure of (cube.measures as readonly Readonly<Record<string, unknown>>[] | undefined) ?? []) {
      assert.doesNotMatch(
        String(measure.sql ?? ""),
        /\{shopify_[a-z0-9_]+\}/u,
        `${stream}.${String(measure.name)} interpolates a foreign cube in measure SQL`,
      );
    }
  }

  for (const stream of SHOPIFY_STREAM_IDS) {
    const cube = byName.get(stream);
    assert.ok(cube);
    const cubeText = JSON.stringify(cube);
    for (const field of SHOPIFY_STREAM_FIELDS[stream as ShopifyStreamId]) {
      if (["rawNode", "nodePayload"].includes(field.name)) continue;
      assert.ok(
        cubeText.includes(snakeCase(field.name)),
        `${stream}.${field.name} is not promoted or explicitly governed by the Cube projection`,
      );
    }
  }
});

test("Shopify cubes retain current rows across mixed per-key mapping versions", async () => {
  const [documents, stagingMigration] = await Promise.all([
    Promise.all(cubeFiles.map((file) => loadYaml<CubeDocument>(file))),
    readFile(stagingMigrationFile, "utf8"),
  ]);
  const cubes = documents.flatMap(({ cubes = [] }) => cubes);
  const byName = new Map(cubes.map((cube) => [String(cube.name), cube]));

  // Typed staging is a current-state table: each source key is updated in
  // place, so different keys can truthfully retain different mapping versions
  // after a connector mapping change. Cube must therefore scan every current
  // key and apply the tombstone predicate plus source-integrity predicates
  // (live-parent and internal collection-marker gates). Those predicates may
  // never select a single mapping version.
  for (const stream of SHOPIFY_STREAM_IDS) {
    const tableStart = `CREATE TABLE IF NOT EXISTS "source_shopify"."${stream}" (`;
    const start = stagingMigration.indexOf(tableStart);
    const end = stagingMigration.indexOf("\n);", start);
    assert.notEqual(start, -1, `${stream} has no typed staging table`);
    assert.notEqual(end, -1, `${stream} typed staging table is unterminated`);
    const tableDefinition = stagingMigration.slice(start, end);
    assert.match(
      tableDefinition,
      /PRIMARY KEY \(tenant_id, namespaced_source_key\)/u,
      `${stream} is not a single current row per source key`,
    );

    const cube = byName.get(stream);
    assert.ok(cube, `missing Cube for ${stream}`);
    const sql = String(cube.sql);
    assert.match(
      sql,
      new RegExp(`FROM source_shopify\\.${stream} t\\s+WHERE NOT t\\.tombstone`, "u"),
      `${stream} must scan current non-tombstoned keys`,
    );
    assert.doesNotMatch(sql, /ARRAY_AGG\s*\(\s*mapping_version/iu);
    assert.doesNotMatch(sql, /GROUP BY\s+tenant_id\s*,\s*connection_id/iu);
    assert.doesNotMatch(sql, /JOIN[^\n]*\bmapping_version\b/iu);
    assert.doesNotMatch(sql, /\bmapping_version\b\s*(?:=|<>|!=|<|>)/iu);
  }

  const mixedCurrentRows = [
    { namespacedSourceKey: "shopify:product:unchanged", mappingVersion: "shopify@1", tombstone: false },
    { namespacedSourceKey: "shopify:product:remapped", mappingVersion: "shopify@2", tombstone: false },
    { namespacedSourceKey: "shopify:product:deleted", mappingVersion: "shopify@1", tombstone: true },
  ] as const;
  const visibleRows = mixedCurrentRows.filter(({ tombstone }) => !tombstone);
  assert.deepEqual(
    visibleRows.map(({ namespacedSourceKey }) => namespacedSourceKey),
    ["shopify:product:unchanged", "shopify:product:remapped"],
  );
  assert.deepEqual(new Set(visibleRows.map(({ mappingVersion }) => mappingVersion)), new Set([
    "shopify@1",
    "shopify@2",
  ]));
});

test("the exhaustive Shopify field view is typed and redacts governed values in SQL", async () => {
  const document = await loadYaml<CubeDocument>(cubeFiles[0]);
  const fields = document.cubes?.find(({ name }) => name === "shopify_fields");
  assert.ok(fields);
  const sql = String(fields.sql);
  assert.match(sql, /protected_data_level/u);
  assert.match(sql, /availability/u);
  assert.match(sql, /deprecated/u);
  assert.doesNotMatch(sql, /node_payload/u);
  // Definitions remain queryable, but observed values require the exact live
  // typed object. This is especially important for deleted customers and for
  // nested children removed while their parent remains live.
  assert.match(sql, /definition_kind[^]*<> 'observed_value'/u);
  for (const [objectType, table] of [
    ["ProductVariant", "shopify_product_variants"],
    ["Customer", "shopify_customers"],
    ["LineItem", "shopify_order_lines"],
    ["OrderTransaction", "shopify_transactions"],
    ["RefundLineItem", "shopify_refund_lines"],
    ["Fulfillment", "shopify_fulfillments"],
    ["Return", "shopify_returns"],
  ] as const) {
    assert.match(sql, new RegExp(`object_type' = '${objectType}'[^]*source_shopify\\.${table}`, "u"));
  }
  assert.match(sql, /ELSE FALSE/u);

  const dimensions = new Set(
    ((fields.dimensions as readonly Readonly<{ name?: string }>[]) ?? []).map(({ name }) => name),
  );
  for (const member of [
    "schema_path", "root_field", "object_type", "graphql_id", "parent_graphql_id",
    "field_name", "field_type", "value_kind", "api_version", "required_scopes",
    "protected_data_level", "availability", "deprecated", "deprecation_reason",
    "safe_value_text", "safe_value_number", "safe_value_boolean",
    "safe_value_timestamp", "safe_value_json", "observed_at", "value_state",
  ]) {
    assert.ok(dimensions.has(member), `shopify_fields.${member} is missing`);
  }

  assert.ok(SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY.counts.fields > 9_000);
});

test("arbitrary metafield literals cannot reach a public Cube member", async () => {
  const [document, views] = await Promise.all([
    loadYaml<CubeDocument>(cubeFiles[0]),
    loadYaml<ViewDocument>(viewFile),
  ]);
  const metafields = document.cubes?.find(({ name }) => name === "shopify_metafield_values");
  const fields = document.cubes?.find(({ name }) => name === "shopify_fields");
  assert.ok(metafields);
  assert.ok(fields);

  const metafieldSql = String(metafields.sql);
  for (const projection of [
    "NULL::text AS value",
    "NULL::jsonb AS json_value",
    "NULL::numeric AS numeric_value",
    "NULL::boolean AS boolean_value",
    "NULL::timestamptz AS datetime_value",
  ]) {
    assert.ok(metafieldSql.includes(projection), `missing redaction projection: ${projection}`);
  }
  assert.doesNotMatch(metafieldSql, /\bt\.(?:value|json_value|numeric_value|boolean_value|datetime_value|raw_node)\b/iu);

  // Defence in depth: even if source classification regresses, every EAV
  // observation whose source object is a Metafield is forced sensitive before
  // any safe_value_* member is calculated.
  const fieldSql = String(fields.sql);
  assert.match(fieldSql, /definition_kind[^]*observed_value/iu);
  assert.match(fieldSql, /root_field[^]*metafieldDefinitions/iu);
  assert.match(fieldSql, /object_type[^]*Metafield/iu);

  const presence = views.views?.find(({ name }) => name === "shopify_metafield_presence_analytics");
  assert.ok(presence);
  const publicPresence = JSON.stringify(presence);
  assert.doesNotMatch(
    publicPresence,
    /"(?:owner_id|value|json_value|numeric_value|boolean_value|datetime_value|compare_digest|raw_node|node_payload)"/iu,
  );
});

test("all public Shopify views are configured and keep protected payloads out", async () => {
  const views = await loadYaml<ViewDocument>(viewFile);
  const config = await loadYaml<AgentConfig>(configFile);
  const configured = new Set(
    (config.accessible_views ?? [])
      .filter(({ connector }) => connector === "shopify")
      .map(({ name }) => name),
  );
  const viewNames = new Set((views.views ?? []).map(({ name }) => String(name)));
  assert.deepEqual([...configured].sort(), [...viewNames].sort());
  assert.ok(configured.has("shopify_source_fields_analytics"));

  const text = await readFile(viewFile, "utf8");
  assert.doesNotMatch(text, /raw_node|node_payload|billing_address|shipping_address/iu);
  for (const view of views.views ?? []) {
    assert.match(JSON.stringify(view), /"tenant_id"/u, `${String(view.name)} lacks tenant scope`);
  }
});
