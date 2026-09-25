import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import yaml from "js-yaml";

const root = path.resolve(import.meta.dirname, "../..");
const cubeDir = path.join(root, "cube-playground/model/cubes");
const viewDir = path.join(root, "cube-playground/model/views");
const agentsDir = path.join(root, "cube-playground/agents");

type Named = Readonly<{ name: string; [key: string]: unknown }>;
type ModelDocument = Readonly<{ cubes?: readonly Named[]; views?: readonly Named[] }>;
type ConnectorTables = Readonly<{
  tableCount: number;
  tables: readonly Readonly<{ id: string; columns: readonly Readonly<{ name: string }>[] }>[];
}>;
type FieldCensus = Readonly<{ apiVersion: string; fieldCount: number }>;

function modelDocuments(dir: string): readonly ModelDocument[] {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => yaml.load(fs.readFileSync(path.join(dir, name), "utf8")) as ModelDocument);
}

const cubes = modelDocuments(cubeDir).flatMap((document) => document.cubes ?? []);
const views = modelDocuments(viewDir).flatMap((document) => document.views ?? []);
const xCubes = cubes.filter((cube) => cube.name.startsWith("lightspeed_x_"));
const xViews = views.filter((view) => view.name.startsWith("lightspeed_x_"));
const tables = JSON.parse(fs.readFileSync(path.join(root, "connectors/lightspeed-x/tables.json"), "utf8")) as ConnectorTables;
const census = JSON.parse(fs.readFileSync(path.join(root, "connectors/lightspeed-x/field-census.generated.json"), "utf8")) as FieldCensus;

function memberNames(container: Named, key: "dimensions" | "measures"): readonly string[] {
  return ((container[key] as readonly Named[] | undefined) ?? []).map((member) => member.name);
}

function cube(name: string): Named {
  const value = xCubes.find((candidate) => candidate.name === name);
  assert.ok(value, `missing Lightspeed X-Series cube ${name}`);
  return value;
}

function view(name: string): Named {
  const value = xViews.find((candidate) => candidate.name === name);
  assert.ok(value, `missing Lightspeed X-Series view ${name}`);
  return value;
}

function viewMembers(value: Named): ReadonlySet<string> {
  const members = new Set<string>();
  for (const binding of (value.cubes as readonly Record<string, unknown>[] | undefined) ?? []) {
    const terminalCube = String(binding.join_path).split(".").at(-1)!;
    const prefixed = binding.prefix === true;
    const sourceCube = cube(terminalCube);
    const sourceMembers = new Set([
      ...memberNames(sourceCube, "dimensions"),
      ...memberNames(sourceCube, "measures"),
    ]);
    for (const include of (binding.includes as readonly (string | Record<string, unknown>)[] | undefined) ?? []) {
      const source = typeof include === "string" ? include : String(include.name);
      const exposed = typeof include === "string" ? include : String(include.alias ?? include.name);
      assert.ok(sourceMembers.has(source), `${value.name} exposes missing ${terminalCube}.${source}`);
      members.add(prefixed ? `${terminalCube}_${exposed}` : exposed);
    }
  }
  return members;
}

test("Lightspeed X-Series publishes a broad curated surface and a one-to-one agent allowlist", () => {
  const expected = [
    "lightspeed_x_sales_analytics",
    "lightspeed_x_product_sales_analytics",
    "lightspeed_x_payments_analytics",
    "lightspeed_x_refunds_analytics",
    "lightspeed_x_customer_analytics",
    "lightspeed_x_stored_value_analytics",
    "lightspeed_x_catalogue_analytics",
    "lightspeed_x_pricing_analytics",
    "lightspeed_x_promotion_analytics",
    "lightspeed_x_inventory_analytics",
    "lightspeed_x_purchasing_analytics",
    "lightspeed_x_fulfillment_analytics",
    "lightspeed_x_services_analytics",
    "lightspeed_x_store_operations_analytics",
    "lightspeed_x_audit_analytics",
    "lightspeed_x_source_explorer",
  ];
  assert.deepEqual(xViews.map(({ name }) => name).sort(), expected.sort());

  const config = yaml.load(fs.readFileSync(path.join(agentsDir, "config.yml"), "utf8")) as {
    accessible_views: readonly { name: string; connector: string; guidance: string }[];
  };
  const configured = config.accessible_views.filter(({ connector }) => connector === "lightspeed-x");
  assert.deepEqual(configured.map(({ name }) => name).sort(), expected.sort());

  for (const semanticView of xViews) {
    assert.ok(String(semanticView.description ?? "").trim().length >= 50, `${semanticView.name} needs a business description`);
    assert.ok(String((semanticView.meta as Record<string, unknown> | undefined)?.ai_context ?? "").trim().length >= 80,
      `${semanticView.name} needs substantive AI context`);
    assert.ok(viewMembers(semanticView).size > 0, `${semanticView.name} must expose real members`);
    const guidance = configured.find(({ name }) => name === semanticView.name)?.guidance ?? "";
    assert.ok(guidance.trim().length >= 80, `${semanticView.name} needs routing guidance`);
  }
});

test("every physical X-Series cube source is an exact scheduled 2026-07 table", () => {
  assert.equal(tables.tableCount, 52);
  const scheduled = new Set(tables.tables.map(({ id }) => id));
  scheduled.add("lx_source_fields");
  const modelText = fs.readdirSync(cubeDir)
    .filter((name) => name.startsWith("lightspeed_x_") && name.endsWith(".yml"))
    .map((name) => fs.readFileSync(path.join(cubeDir, name), "utf8"))
    .join("\n");
  const referenced = new Set([...modelText.matchAll(/source_lightspeed_x\.(lx_[a-z0-9_]+)/gu)].map((match) => match[1]));
  for (const table of referenced) assert.ok(scheduled.has(table), `Cube references unscheduled physical table ${table}`);
  assert.ok(referenced.size >= 25, "curated models should span the major X-Series domains");
  assert.doesNotMatch(modelText, /source_lightspeed_x\.lx_stock_adjustments\b/u);
  assert.match(modelText, /source_lightspeed_x\.lx_sales\b/u);
  assert.match(modelText, /source_lightspeed_x\.lx_inventory\b/u);
  assert.match(modelText, /source_lightspeed_x\.lx_consignments\b/u);
  assert.match(modelText, /source_lightspeed_x\.lx_source_fields\b/u);
});

test("all X-Series joins bind both tenant and connection and raw cubes stay private", () => {
  assert.ok(xCubes.length >= 35);
  for (const semanticCube of xCubes) {
    assert.equal(semanticCube.public, false, `${semanticCube.name} must remain private`);
    const dimensions = new Map(
      ((semanticCube.dimensions as readonly Named[] | undefined) ?? []).map((dimension) => [dimension.name, dimension]),
    );
    for (const identity of ["tenant_id", "connection_id"]) {
      const dimension = dimensions.get(identity);
      assert.ok(dimension, `${semanticCube.name} lacks ${identity}`);
      assert.equal(dimension.public, false, `${semanticCube.name}.${identity} must not be user-selectable identity data`);
    }
    for (const join of (semanticCube.joins as readonly Named[] | undefined) ?? []) {
      const sql = String(join.sql);
      assert.match(sql, /\{CUBE\}\.tenant_id\s*=\s*\{lightspeed_x_[a-z_]+\}\.tenant_id/u,
        `${semanticCube.name}.${join.name} lacks tenant-safe equality`);
      assert.match(sql, /\{CUBE\}\.connection_id\s*=\s*\{lightspeed_x_[a-z_]+\}\.connection_id/u,
        `${semanticCube.name}.${join.name} lacks connection-safe equality`);
    }
  }
});

test("the X-Series source explorer is exhaustive, typed and lossless", () => {
  assert.equal(census.apiVersion, "2026-07");
  assert.equal(census.fieldCount, 5_202);
  for (const table of tables.tables) {
    const columns = new Set(table.columns.map(({ name }) => name));
    assert.ok(columns.has("payload_json"), `${table.id} cannot support curated payload semantics`);
    assert.ok(columns.has("field_index"), `${table.id} cannot participate in exhaustive field exploration`);
  }
  const explorer = cube("lightspeed_x_source_fields");
  assert.match(String(explorer.sql), /source_lightspeed_x\.lx_source_fields/u);
  assert.deepEqual([
    "parent_stream", "source_object_type", "source_record_id", "field_path",
    "field_ordinal_path", "field_name", "value_type", "string_value",
    "number_value", "boolean_value", "timestamp_value", "date_value", "json_value",
  ].filter((name) => !memberNames(explorer, "dimensions").includes(name)), []);
  assert.deepEqual([
    "field_occurrences", "source_records", "numeric_value_sum",
    "numeric_value_average", "numeric_value_minimum", "numeric_value_maximum",
  ].filter((name) => !memberNames(explorer, "measures").includes(name)), []);
  assert.match(JSON.stringify(explorer.meta), /every field_index entry/iu);
  assert.match(JSON.stringify(view("lightspeed_x_source_explorer").meta), /filter parent_stream or source_object_type/iu);
  assert.match(JSON.stringify(view("lightspeed_x_source_explorer").meta), /exact field_path/iu);
});

test("curated money, sale-state and refund semantics preserve X-Series source units and lifecycle", () => {
  const allX = xCubes.map((value) => JSON.stringify(value)).join("\n");
  const sales = JSON.stringify(cube("lightspeed_x_sales"));
  const lines = JSON.stringify(cube("lightspeed_x_sale_lines"));
  const payments = JSON.stringify(cube("lightspeed_x_sale_payments"));
  const returns = JSON.stringify(cube("lightspeed_x_returns"));
  const customers = JSON.stringify(cube("lightspeed_x_customers"));
  const giftTransactions = JSON.stringify(cube("lightspeed_x_gift_card_transactions"));

  assert.doesNotMatch(allX, /\/\s*100(?:\.0+)?\b|POWER\s*\(\s*10/iu, "X-Series money is already in major units");
  assert.match(sales, /state' = 'closed'/u);
  assert.match(sales, /state' = 'parked'/u);
  assert.match(sales, /state' = 'pending'/u);
  assert.match(sales, /state' = 'voided'/u);
  assert.match(sales, /gift_card_load_value_excluding_tax/u);
  assert.match(lines, /jsonb_extract_path_text\([^)]*'pricing', 'total'\)/u);
  assert.match(lines, /jsonb_extract_path_text\([^)]*'pricing', 'cost_total'\)/u);
  assert.match(payments, /amount.*< 0|< 0.*amount/u);
  assert.match(returns, /jsonb_extract_path_text\([^)]*'return', 'is_return'\)/u);
  assert.match(returns, /ABS\(/u);
  assert.match(customers, /GROUP BY tenant_id, connection_id, customer_id/u);
  assert.match(customers, /retailer\.tenant_id = customer\.tenant_id/u);
  assert.match(customers, /retailer\.connection_id = customer\.connection_id/u);
  assert.match(giftTransactions, /REVERSING/u);
  assert.match(giftTransactions, /direction requires the related transaction/iu);
  assert.doesNotMatch(giftTransactions, /'RELOADING', 'REVERSING'/u);
});

test("curated X-Series views do not publish direct PII and unavailable write-scope reads stay unavailable", () => {
  const prohibited = new Set(["email", "mobile", "phone", "date_of_birth", "ip_address", "user_agent", "old_data", "changed_data"]);
  for (const semanticView of xViews) {
    assert.deepEqual([...viewMembers(semanticView)].filter((member) => prohibited.has(member)), [],
      `${semanticView.name} publishes a direct PII member`);
  }
  const rules = fs.readFileSync(path.join(agentsDir, "rules/lightspeed-x-money-state-and-routing.md"), "utf8");
  assert.match(rules, /inventory:write/u);
  assert.match(rules, /Unavailable/u);
  assert.match(rules, /read-only grant/u);
  assert.match(rules, /PII/u);
});

test("every X-Series certified query is single-view and references real public members", () => {
  const config = yaml.load(fs.readFileSync(path.join(agentsDir, "config.yml"), "utf8")) as {
    accessible_views: readonly { name: string; connector: string }[];
  };
  const accessible = new Set(
    config.accessible_views.filter(({ connector }) => connector === "lightspeed-x").map(({ name }) => name),
  );
  const files = fs.readdirSync(path.join(agentsDir, "certified_queries"))
    .filter((name) => name.startsWith("lightspeed-x-") && name.endsWith(".md"));
  assert.equal(files.length, 16, "X-Series should ship one governed query pattern per public view");
  for (const file of files) {
    const body = fs.readFileSync(path.join(agentsDir, "certified_queries", file), "utf8");
    const match = body.match(/```json\n([\s\S]*?)```/u);
    assert.ok(match, `${file} lacks a JSON query`);
    const query = JSON.parse(match[1]) as Record<string, unknown>;
    const references = JSON.stringify(query).match(/lightspeed_x_[a-z_]+\.[a-z0-9_]+/gu) ?? [];
    assert.ok(references.length > 0, `${file} has no X-Series members`);
    const semanticViewNames = new Set(references.map((reference) => reference.split(".")[0]));
    assert.equal(semanticViewNames.size, 1, `${file} mixes semantic views or grains`);
    const semanticViewName = [...semanticViewNames][0];
    assert.ok(accessible.has(semanticViewName), `${file} uses inaccessible ${semanticViewName}`);
    const members = viewMembers(view(semanticViewName));
    for (const reference of references) {
      const member = reference.slice(semanticViewName.length + 1);
      assert.ok(members.has(member), `${file} references missing ${reference}`);
    }
  }
});
