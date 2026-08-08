/**
 * The Lightspeed grounding contract: everything the agent is taught about
 * source_lightspeed must be true of the live typed-staging DDL.
 *
 * Column truth is parsed from every analytical migration (CREATE TABLE plus
 * ALTER TABLE ADD COLUMN), the same way the generator builds the prompt docs.
 * If a playbook names a column the database does not have, or the generated
 * dictionary misses a table, this test fails before the agent ever does.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const MIGRATIONS = new URL("../../infra/migrations/analytical/", import.meta.url);

const PLATFORM_COLUMNS = new Set([
  "tenant_id", "namespaced_source_key", "connection_id", "external_account_reference",
  "source_record_id", "source_version", "source_updated_at", "payload_hash",
  "payload_batch_id", "sync_run_id", "tombstone", "mapping_version",
  "first_ingested_at", "ingested_at",
]);

function parseDdl(): Map<string, Set<string>> {
  const db = new Map<string, Set<string>>();
  const createRe = /CREATE TABLE IF NOT EXISTS "?source_lightspeed"?\."?(\w+)"?\s*\(([\s\S]*?)\n\);/g;
  const alterRe = /ALTER TABLE\s+"?source_lightspeed"?\."?(\w+)"?\s+((?:ADD COLUMN IF NOT EXISTS\s+"?\w+"?[^,;]*[,;]?\s*)+)/g;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(file, MIGRATIONS), "utf8");
    let match: RegExpExecArray | null;
    while ((match = createRe.exec(sql))) {
      const cols = [...match[2]!.matchAll(/^\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s+/gm)].map((x) => x[1]!);
      const existing = db.get(match[1]!) ?? new Set<string>();
      for (const col of cols) existing.add(col);
      db.set(match[1]!, existing);
    }
    while ((match = alterRe.exec(sql))) {
      const cols = [...match[2]!.matchAll(/ADD COLUMN IF NOT EXISTS\s+"?(\w+)"?/g)].map((x) => x[1]!);
      const existing = db.get(match[1]!) ?? new Set<string>();
      for (const col of cols) existing.add(col);
      db.set(match[1]!, existing);
    }
  }
  return db;
}

const ddl = parseDdl();
const lsTables = new Set([...ddl.keys()].filter((t) => t.startsWith("ls_")));

const playbooksDir = new URL("../../connectors/lightspeed-r/playbooks/", import.meta.url);
const playbookFiles = readdirSync(playbooksDir).filter((f) => f.endsWith(".md")).sort();

test("the migrations actually define the ls_ staging surface", () => {
  assert.ok(lsTables.size >= 90, `expected at least 90 ls_ tables, parsed ${lsTables.size}`);
  assert.ok(ddl.get("ls_sale_lines")?.has("sale_id"), "ls_sale_lines.sale_id must be parsed from DDL");
  assert.ok(ddl.get("ls_sale_lines")?.has("complete_time"), "ALTER TABLE additions must be parsed");
});

test("the generated table index covers every ls_ table", async () => {
  const { LIGHTSPEED_TABLE_INDEX } = await import("../../packages/agent/src/generated-staging-schema.js");
  for (const table of lsTables) {
    assert.match(LIGHTSPEED_TABLE_INDEX, new RegExp(`^${table} `, "mu"), `table index is missing ${table}`);
  }
});

test("every generated dictionary column exists in the live DDL", async () => {
  const { LIGHTSPEED_DIMENSION_DICTIONARIES } = await import("../../packages/agent/src/generated-staging-schema.js");
  const seenTables = new Set<string>();
  for (const [dimension, doc] of Object.entries(LIGHTSPEED_DIMENSION_DICTIONARIES)) {
    let table = "";
    for (const line of doc.split("\n")) {
      const tableMatch = /^source_lightspeed\.(\w+)/u.exec(line);
      if (tableMatch) {
        table = tableMatch[1] ?? "";
        seenTables.add(table);
        assert.ok(lsTables.has(table), `${dimension} dictionary documents unknown table ${table}`);
        continue;
      }
      const columnMatch = /^ {2}([a-z0-9_]+)(?: —|$)/u.exec(line);
      if (!columnMatch || !table) continue;
      const column = columnMatch[1] ?? "";
      assert.ok(
        ddl.get(table)?.has(column) || PLATFORM_COLUMNS.has(column),
        `${dimension} dictionary teaches ${table}.${column}, which the DDL does not define`,
      );
    }
  }
  for (const table of lsTables) {
    assert.ok(seenTables.has(table), `no dictionary documents ${table}`);
  }
});

test("every qualified column reference in the playbooks exists in the live DDL", () => {
  for (const file of playbookFiles) {
    const text = readFileSync(new URL(file, playbooksDir), "utf8");
    for (const [, table, column] of text.matchAll(/\b(ls_[a-z0-9_]+)\.([a-z0-9_]+)\b/gu)) {
      if (!table || !column) continue;
      assert.ok(lsTables.has(table), `${file} references unknown table ${table}`);
      assert.ok(
        ddl.get(table)!.has(column) || PLATFORM_COLUMNS.has(column),
        `${file} references ${table}.${column}, which the DDL does not define`,
      );
    }
    for (const [, table] of text.matchAll(/\bsource_lightspeed\.(\w+)\b/gu)) {
      if (!table) continue;
      assert.ok(
        table.startsWith("ls_") && lsTables.has(table),
        `${file} references source_lightspeed.${table}, which is not a live ls_ table`,
      );
    }
  }
});

test("every intent domain maps to an existing guide and dictionary", async () => {
  const { connectorDimensionGuideNames } = await import("../../packages/agent/src/generated-connector-playbooks.js");
  const { LIGHTSPEED_DIMENSION_DICTIONARIES } = await import("../../packages/agent/src/generated-staging-schema.js");
  const { dimensionGuideBundle } = await import("../../services/conversation/src/live.js");
  const guides = connectorDimensionGuideNames("lightspeed-r");
  assert.deepEqual(
    [...guides].sort(),
    ["customers", "employees", "inventory", "purchasing", "sales", "workshop"],
  );
  for (const guide of guides) {
    const bundle = dimensionGuideBundle(guide);
    assert.ok(bundle, `dimensionGuideBundle(${guide}) returned nothing`);
    assert.match(bundle!, /COLUMN DICTIONARY/u, `${guide} bundle is missing its column dictionary`);
  }
  // Every dictionary dimension is reachable through at least one guide bundle.
  const reachable = new Set<string>();
  for (const guide of guides) {
    const bundle = dimensionGuideBundle(guide)!;
    for (const dimension of Object.keys(LIGHTSPEED_DIMENSION_DICTIONARIES)) {
      if (bundle.includes(`— ${dimension}`) || bundle.includes(`${dimension},`) || bundle.includes(`, ${dimension}`)) {
        reachable.add(dimension);
      }
    }
  }
  for (const dimension of ["sales", "catalogue", "inventory", "customers", "purchasing", "workshop", "org", "registers"]) {
    assert.ok(reachable.has(dimension), `dictionary dimension ${dimension} is not reachable from any guide`);
  }
});

test("the retired unprefixed staging tables never appear in prompt material", async () => {
  const { LIGHTSPEED_TABLE_INDEX, LIGHTSPEED_DIMENSION_DICTIONARIES } = await import("../../packages/agent/src/generated-staging-schema.js");
  const docs = [LIGHTSPEED_TABLE_INDEX, ...Object.values(LIGHTSPEED_DIMENSION_DICTIONARIES)];
  for (const doc of docs) {
    for (const [, table] of doc.matchAll(/source_lightspeed\.(\w+)/gu)) {
      assert.ok(table!.startsWith("ls_"), `prompt material references retired table source_lightspeed.${table}`);
    }
  }
});
