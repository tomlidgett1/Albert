import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import { XERO_SCAN_PLAN, XERO_SPEC_TABLES } from "../../connectors/xero/scan-plan.js";
import { packageSdkProject } from "../../services/sync-workers/src/fivetran-sdk-package.js";

/**
 * The Fivetran SDK Xero connector is generated from the same tables.json the
 * native pack uses. These checks fail when the generated module drifts from
 * the spec, when the package would ship something Fivetran rejects, or when
 * the Python side stops agreeing with the TypeScript projection.
 */
const specPy = readFileSync("connectors/xero-fivetran-sdk/xero_spec.py", "utf8");
const specJson = specPy.slice(specPy.indexOf("json.loads(r'''") + "json.loads(r'''".length, specPy.lastIndexOf("''')"));
const spec = JSON.parse(specJson) as {
  tables: Record<string, unknown>;
  groups: readonly { leader: string; members: readonly { table: string }[] }[];
  fanOuts: readonly { id: string; members: readonly { table: string }[] }[];
};

test("xero_spec.py carries every spec table, group and fan-out from tables.json", () => {
  assert.equal(Object.keys(spec.tables).length, XERO_SPEC_TABLES.length);
  assert.deepEqual(
    Object.keys(spec.tables).sort(),
    XERO_SPEC_TABLES.map((table) => table.id).sort(),
  );
  assert.equal(spec.groups.length, XERO_SCAN_PLAN.groups.length);
  assert.equal(spec.fanOuts.length, XERO_SCAN_PLAN.fanOuts.length);
  assert.deepEqual(
    spec.groups.map((group) => group.leader).sort(),
    XERO_SCAN_PLAN.groups.map((group) => group.leader.id).sort(),
  );
  const covered = new Set<string>([
    ...spec.groups.flatMap((group) => group.members.map((member) => member.table)),
    ...spec.fanOuts.flatMap((fanOut) => [fanOut.id, ...fanOut.members.map((member) => member.table)]),
  ]);
  assert.equal(covered.size, XERO_SPEC_TABLES.length, "every table is reachable from a walk");
});

test("the SDK package ships only connector code, deterministically", () => {
  const first = packageSdkProject("connectors/xero-fivetran-sdk");
  const second = packageSdkProject("connectors/xero-fivetran-sdk");
  assert.deepEqual(first.files, [
    "connector.py", "xero_client.py", "xero_projection.py", "xero_reports.py", "xero_spec.py", "xero_sync.py",
  ]);
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.files.every((file) => /\.py$|(^|\/)requirements\.txt$/u.test(file)));
  // The archive itself also carries Fivetran's (empty) configuration_form.pb.
  assert.ok(first.bytes.includes(Buffer.from("configuration_form.pb")));
});

test("the Python connector's projection matches the TypeScript engine on the recording", () => {
  const output = execFileSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "connectors/xero-fivetran-sdk/tests", "-p", "test_*.py"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  void output;
});

test("spec column names never carry an underscore before a digit (Fivetran rename is invertible)", () => {
  // Fivetran turns address_line1 into address_line_1 in the destination; the
  // union views (0168) undo exactly that letter_digit transition. That is only
  // safe while no contract column legitimately contains one.
  const offenders = XERO_SPEC_TABLES.flatMap((table) =>
    table.columns.filter((column) => /[a-z]_[0-9]/u.test(column.name)).map((column) => `${table.id}.${column.name}`));
  assert.deepEqual(offenders, []);
});
