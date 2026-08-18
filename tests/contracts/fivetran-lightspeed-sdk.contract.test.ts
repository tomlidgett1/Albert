import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { LIGHTSPEED_SCAN_PLAN } from "../../connectors/lightspeed-r/spec-sync.js";
import { SPEC_TABLES } from "../../connectors/lightspeed-r/scan-plan.js";
import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { buildStagingContracts } from "../../packages/connector-sdk/src/staging.js";
import { FIVETRAN_SERVICES } from "../../packages/fivetran/src/index.js";
import { packageSdkProject } from "../../services/sync-workers/src/fivetran-sdk-package.js";

/**
 * The Fivetran SDK Lightspeed R-Series connector is generated from the same
 * tables.json the native pack uses. These checks fail when the generated
 * module drifts from the spec or the staging contract, when the package would
 * ship something Fivetran rejects, or when the Python side stops agreeing with
 * the TypeScript projection.
 */
const specPy = readFileSync("connectors/lightspeed-fivetran-sdk/lightspeed_spec.py", "utf8");
const specJson = specPy.slice(specPy.indexOf("json.loads(r'''") + "json.loads(r'''".length, specPy.lastIndexOf("''')"));
const spec = JSON.parse(specJson) as {
  tables: Record<string, { columns: readonly { column: string; field: string; type: string }[] }>;
  groups: readonly { resource: string; leader: string; incremental: string; relations: readonly string[]; members: readonly { table: string; projectFrom: string | null }[] }[];
  fanOuts: readonly { table: string; alwaysOn: boolean }[];
};

test("lightspeed_spec.py carries every spec table, group and fan-out from tables.json", () => {
  assert.equal(Object.keys(spec.tables).length, SPEC_TABLES.length);
  assert.deepEqual(Object.keys(spec.tables).sort(), SPEC_TABLES.map((table) => table.id).sort());
  assert.equal(spec.groups.length, LIGHTSPEED_SCAN_PLAN.groups.length);
  assert.equal(spec.fanOuts.length, LIGHTSPEED_SCAN_PLAN.fanOuts.length);
  assert.deepEqual(
    spec.groups.map((group) => group.leader).sort(),
    LIGHTSPEED_SCAN_PLAN.groups.map((group) => group.leader.id).sort(),
  );
  const covered = new Set<string>([
    ...spec.groups.flatMap((group) => group.members.map((member) => member.table)),
    ...spec.fanOuts.map((fanOut) => fanOut.table),
  ]);
  assert.equal(covered.size, SPEC_TABLES.length, "every table is reachable from a walk");
  // No prose ever rides into a projection path or a relation list.
  for (const group of spec.groups) {
    for (const member of group.members) {
      if (member.projectFrom) assert.match(member.projectFrom, /^[A-Za-z][A-Za-z0-9.]*$/u, `${member.table} projectFrom`);
    }
    for (const relation of group.relations) assert.match(relation, /^[A-Za-z][A-Za-z0-9.]*$/u, `${group.resource} relation`);
  }
  // Register calculated totals feed cash_management.yml, so that fan-out is never opt-in.
  assert.equal(spec.fanOuts.find((fanOut) => fanOut.table === "ls_register_calculated")?.alwaysOn, true);
});

test("every landed table is the exact source_lightspeed staging shape (column names, order, types)", () => {
  const staging = buildStagingContracts([lightspeedRManifest]);
  for (const contract of staging) {
    const table = spec.tables[contract.stream];
    assert.ok(table, `${contract.stream} missing from lightspeed_spec.py`);
    assert.deepEqual(
      table.columns.map((column) => [column.column, column.field, column.type]),
      contract.fields.map((field) => [field.column, field.sourceField, field.type]),
      `${contract.stream} columns drifted from the staging contract`,
    );
  }
  // The 0125 parent-context columns are part of the landed shape.
  assert.ok(spec.tables.ls_sale_lines.columns.some((column) => column.column === "completed"));
  assert.ok(spec.tables.ls_purchase_order_lines.columns.some((column) => column.column === "vendor_id"));
});

test("the SDK package ships only connector code, deterministically", () => {
  const first = packageSdkProject("connectors/lightspeed-fivetran-sdk");
  const second = packageSdkProject("connectors/lightspeed-fivetran-sdk");
  assert.deepEqual(first.files, [
    "connector.py", "lightspeed_client.py", "lightspeed_projection.py", "lightspeed_spec.py", "lightspeed_sync.py",
  ]);
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.bytes.includes(Buffer.from("configuration_form.pb")));
});

test("the Python connector's projection matches the TypeScript engine and the walk runs end to end", () => {
  const output = execFileSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "connectors/lightspeed-fivetran-sdk/tests", "-p", "test_*.py"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  void output;
});

test("Lightspeed R-Series is an API-authorised (SDK) Fivetran service — no Connect Card", () => {
  assert.equal(FIVETRAN_SERVICES.light_speed_retail.authorization, "api");
  assert.equal(FIVETRAN_SERVICES.light_speed_retail.schemaPrefix, "lightspeed");
  const webFlow = readFileSync("services/oauth/src/web-flow.ts", "utf8");
  assert.match(webFlow, /"fivetran-lightspeed": "lightspeed-r"/u);
  assert.match(webFlow, /"fivetran-lightspeed": "lightspeed",/u);
  const ui = readFileSync("app/dash/components/ConnectionsWorkspace.tsx", "utf8");
  const lightspeedEntry = ui.slice(ui.indexOf('"fivetran-lightspeed": Object.freeze({'), ui.indexOf('"fivetran-deputy": Object.freeze({'));
  assert.match(lightspeedEntry, /handoff: null/u);
  const worker = readFileSync("services/sync-workers/src/fivetran-http.ts", "utf8");
  assert.match(worker, /service === "light_speed_retail"/u);
  assert.match(worker, /lightspeed_account_id: input\.externalAccountReference/u);
  const main = readFileSync("services/sync-workers/src/main.ts", "utf8");
  assert.match(main, /connectorKey: "lightspeed-r"/u);
  const dockerfile = readFileSync("Dockerfile.services", "utf8");
  assert.match(dockerfile, /connectors\/lightspeed-fivetran-sdk\/\*\.py/u);
});

test("staging column names have no digit_letter or letter_digit underscore ambiguity the union views cannot invert", () => {
  // Fivetran inserts an underscore at letter<->digit boundaries. The union
  // views (0171) invert it through albert_column_contract by comparing
  // underscore-stripped names, which is only unambiguous while no two
  // contract columns of one table collapse to the same stripped name.
  for (const [tableId, table] of Object.entries(spec.tables)) {
    const stripped = table.columns.map((column) => column.column.replaceAll("_", ""));
    assert.equal(new Set(stripped).size, stripped.length, `${tableId} has columns that differ only by underscores`);
  }
});

test("0171 seeds every ls_* union view and Cube reads source_lightspeed_official", () => {
  const migration = readFileSync("infra/migrations/analytical/0171_m2_lightspeed_source_views_over_fivetran.sql", "utf8");
  for (const table of SPEC_TABLES) {
    assert.match(migration, new RegExp(`CREATE VIEW source_lightspeed_fivetran\\.${table.id} AS`, "u"), `${table.id} seed view`);
    assert.match(migration, new RegExp(`rebuild_lightspeed_official_view\\('${table.id}'\\)`, "u"), `${table.id} official view`);
  }
  assert.match(migration, /albert_column_contract/u);
  assert.match(migration, /''fivetran-sdk''::text AS mapping_version/u);
  assert.match(migration, /u\._albert_synced_at AS ingested_at/u);
  assert.match(migration, /expected 90 ls_ official views/u);
  // The union-view builder stubs views whose every bound schema retired, so a
  // purge can never cascade into the Cube contract.
  assert.match(migration, /WHERE false', target_schema, stale\.name, stub_list/u);

  const cubeDir = "cube-playground/model/cubes";
  const offenders = readdirSync(cubeDir)
    .filter((file) => file.endsWith(".yml"))
    .flatMap((file) => {
      const body = readFileSync(`${cubeDir}/${file}`, "utf8");
      return /\bsource_lightspeed\.ls_/u.test(body) ? [file] : [];
    });
  assert.deepEqual(offenders, [], "cube models must read source_lightspeed_official.ls_*");
  const readers = readdirSync(cubeDir)
    .filter((file) => file.endsWith(".yml"))
    .filter((file) => /source_lightspeed_official\.ls_/u.test(readFileSync(`${cubeDir}/${file}`, "utf8")));
  assert.ok(readers.length >= 13, `expected the 13 Lightspeed cube files to read the official layer, found ${readers.length}`);
});
