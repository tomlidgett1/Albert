/**
 * Generate the Fivetran Connector SDK Xero spec module and its parity fixture.
 *
 * The SDK connector (connectors/xero-fivetran-sdk/) is a Python port of the
 * spec-driven Xero walk in connectors/xero. Fivetran only ships `.py` files
 * with a connector, so the plan cannot be read from tables.json at runtime:
 * this script resolves the scan plan (groups, fan-outs, per-API transport
 * profiles, base params, extra passes) once and writes it as a Python literal.
 *
 * It also projects the sanitized recording through the TypeScript engine and
 * writes the rows it produced, so the Python projection can be asserted equal
 * to the reference implementation table by table, column by column.
 *
 *   npx tsx scripts/generate-fivetran-xero-sdk-spec.ts
 *
 * Both outputs are committed; tests/contracts/fivetran-xero-sdk.contract.test.ts
 * fails when they drift from tables.json.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { XERO_SCAN_PLAN, XERO_SPEC_REVISION, XERO_SPEC_TABLES, type XeroSpecTable } from "../connectors/xero/scan-plan.js";
import {
  XERO_API_PROFILES,
  XERO_ATTACHMENT_PARENTS,
  XERO_HISTORY_PARENTS,
  baseParams,
  endpointPath,
  extraParamPasses,
  projectStreamRows,
  templatedParents,
  unwrapEnvelope,
} from "../connectors/xero/spec-sync.js";

const OUT_DIR = resolve("connectors/xero-fivetran-sdk");
const FIXTURE_DIR = resolve(OUT_DIR, "tests");
const NOW = "2026-08-17T00:00:00.000Z";

function tableLiteral(table: XeroSpecTable) {
  return {
    id: table.id,
    primaryKey: table.primaryKey,
    recordIdField: table.recordIdField,
    sourceObjects: table.sourceObjects,
    source: {
      api: table.source.api,
      endpointOp: table.source.endpointOp,
      envelope: table.source.envelope,
      arrayKey: table.source.arrayKey,
      explodePath: table.source.explodePath,
      explodeChain: table.source.explodeChain ?? [],
      parentTable: table.source.parentTable,
      fanOutParam: table.source.fanOutParam,
      pagination: table.source.pagination,
      modifiedField: table.source.modifiedField,
      whereFilterable: table.source.whereFilterable,
      scopes: table.source.scopes,
      availability: table.source.availability,
    },
    columns: table.columns.map((column) => ({ name: column.name, type: column.type, api: column.api })),
  };
}

const plan = XERO_SCAN_PLAN;
const spec = {
  revision: XERO_SPEC_REVISION,
  profiles: XERO_API_PROFILES,
  tables: Object.fromEntries(XERO_SPEC_TABLES.map((table) => [table.id, tableLiteral(table)])),
  groups: plan.groups.map((group) => ({
    key: `${group.api} ${group.endpointOp} ${group.leader.source.arrayKey ?? ""}`.trim(),
    api: group.api,
    endpointOp: group.endpointOp,
    path: endpointPath(group.leader),
    resource: group.resource,
    leader: group.leader.id,
    members: group.members.map((member) => ({ table: member.table.id, projectFrom: member.projectFrom })),
    pagination: group.pagination,
    modifiedField: group.modifiedField,
    whereFilterable: group.whereFilterable,
    baseParams: baseParams(group.leader),
    extraPasses: extraParamPasses(group.leader, NOW),
    availability: group.leader.source.availability,
  })),
  fanOuts: plan.fanOuts.map((fanOut) => ({
    id: fanOut.table.id,
    api: fanOut.table.source.api,
    endpointOp: fanOut.endpointOp,
    path: endpointPath(fanOut.table),
    fanOutParam: fanOut.fanOutParam,
    parentTable: fanOut.parentTable || null,
    availability: fanOut.table.source.availability,
    members: fanOut.members.map((member) => ({ table: member.table.id, projectFrom: member.projectFrom })),
    templatedParents: templatedParents(fanOut),
  })),
  attachmentParents: XERO_ATTACHMENT_PARENTS,
  historyParents: XERO_HISTORY_PARENTS,
};

const specJson = JSON.stringify(spec, null, 1);
const specHash = createHash("sha256").update(specJson).digest("hex");
const py = `# GENERATED FILE — do not edit.
# Source: connectors/xero/tables.json (${XERO_SPEC_REVISION}) via
# scripts/generate-fivetran-xero-sdk-spec.ts. Regenerate with:
#   npx tsx scripts/generate-fivetran-xero-sdk-spec.ts
import json

SPEC_SHA256 = "${specHash}"

SPEC = json.loads(r'''${specJson.replace(/'''/g, "'\\''\\''")}''')
`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, "xero_spec.py"), py);

/* ------------------------------------------------------------------ */
/* Parity fixture: reference projection of the sanitized recording.    */
/* ------------------------------------------------------------------ */
const recording = JSON.parse(readFileSync(resolve("connectors/xero/fixtures/sanitized-recording.json"), "utf8")) as {
  responses: Record<string, unknown>;
};
const byId = new Map(XERO_SPEC_TABLES.map((table) => [table.id, table]));
const expected: Record<string, unknown[]> = {};

// Group members project from the leader's recorded response.
for (const group of plan.groups) {
  const body = recording.responses[group.leader.id];
  if (body === undefined) continue;
  const records = unwrapEnvelope(body, group.leader);
  for (const member of group.members) {
    const rows = projectStreamRows({
      table: member.table,
      leaderTable: group.leader,
      resource: group.resource,
      records,
      recordIdField: member.table.recordIdField ?? "",
      synthetics: {},
    });
    expected[member.table.id] = rows.map((row) => ({
      sourceRecordId: row.sourceRecordId,
      fields: row.normalized?.fields ?? {},
      tombstone: row.normalized?.tombstone ?? false,
    }));
  }
}
// Fan-out walks and their members project from the fan-out's recorded response.
for (const fanOut of plan.fanOuts) {
  const body = recording.responses[fanOut.table.id];
  if (body === undefined) continue;
  const records = unwrapEnvelope(body, fanOut.table);
  const parent = fanOut.parentTable ? byId.get(fanOut.parentTable) ?? null : null;
  const parentBody = parent ? recording.responses[parent.id] : undefined;
  const parentRecord = parent && parentBody !== undefined ? unwrapEnvelope(parentBody, parent)[0] : undefined;
  for (const member of [{ table: fanOut.table, projectFrom: null }, ...fanOut.members]) {
    const rows = projectStreamRows({
      table: member.table,
      leaderTable: fanOut.table,
      resource: fanOut.table.source.arrayKey ?? fanOut.table.source.envelope ?? fanOut.table.id,
      records,
      recordIdField: member.table.recordIdField ?? "",
      ...(parent && parentRecord !== undefined ? { fanOutParent: { record: parentRecord, table: parent } } : {}),
      synthetics: {},
    });
    expected[member.table.id] = rows.map((row) => ({
      sourceRecordId: row.sourceRecordId,
      fields: row.normalized?.fields ?? {},
      tombstone: row.normalized?.tombstone ?? false,
    }));
  }
}
mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(resolve(FIXTURE_DIR, "expected_projection.json"), JSON.stringify(expected, null, 1));
writeFileSync(resolve(FIXTURE_DIR, "sanitized-recording.json"), JSON.stringify(recording));

console.log(`xero_spec.py: ${plan.groups.length} groups, ${plan.fanOuts.length} fan-outs, ${Object.keys(spec.tables).length} tables (sha256 ${specHash.slice(0, 12)})`);
console.log(`expected_projection.json: ${Object.keys(expected).length} tables`);
