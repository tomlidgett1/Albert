/**
 * Generate the Fivetran Connector SDK Lightspeed R-Series spec module and its
 * parity fixtures.
 *
 * The SDK connector (connectors/lightspeed-fivetran-sdk/) is a Python port of
 * the spec-driven R-Series walk in connectors/lightspeed-r. Fivetran ships only
 * `.py` files with a connector, so the plan cannot be read from tables.json at
 * runtime: this script resolves the scan plan (groups, member-need relation
 * unions, extra passes, fan-outs, incremental strategy) and the staging column
 * contract of every table once, and writes them as a Python literal.
 *
 * It also assembles a nested walk page per scan group from the sanitized
 * recording (the recording is keyed per stream; the walk shape nests members
 * under their `projectFrom` path), projects it through the TypeScript engine,
 * and writes both the input pages and the rows produced — so the Python
 * projection can be asserted equal to the reference implementation table by
 * table, column by column.
 *
 *   npx tsx scripts/generate-fivetran-lightspeed-sdk-spec.ts
 *
 * All outputs are committed; tests/contracts/fivetran-lightspeed-sdk.contract.test.ts
 * fails when they drift from tables.json.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { hashPayload } from "../packages/connector-sdk/src/normalization.js";
import { buildStagingContracts } from "../packages/connector-sdk/src/staging.js";
import { parseEnvelope } from "../connectors/lightspeed-r/fetch-core.js";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.js";
import { LIGHTSPEED_SCAN_PLAN, projectStreamRows, resolveStreamScan } from "../connectors/lightspeed-r/spec-sync.js";
import { SPEC_TABLES, type SpecTable } from "../connectors/lightspeed-r/scan-plan.js";
import { LIGHTSPEED_STREAMS, apiOwner, ownResource } from "../connectors/lightspeed-r/streams.js";

const OUT_DIR = resolve("connectors/lightspeed-fivetran-sdk");
const FIXTURE_DIR = resolve(OUT_DIR, "tests");

/**
 * Relations the vendor legitimately omits from every record of a page — kept
 * in lock-step with SPARSE_RELATIONS in connectors/lightspeed-r/fetch-core.ts.
 */
const SPARSE_RELATIONS = [
  "CreditAccount.Contact",
  "Customer.Note",
  "Customer.CustomFieldValues",
  "Item.ItemComponents",
  "Item.ItemFees",
  "Item.ItemVendorNums",
];

const staging = buildStagingContracts([lightspeedRManifest]);
const byId = new Map(SPEC_TABLES.map((table) => [table.id, table]));
const streamById = new Map(LIGHTSPEED_STREAMS.map((stream) => [stream.id, stream]));

function tableLiteral(table: SpecTable) {
  const contract = staging.find((entry) => entry.stream === table.id);
  if (!contract) throw new Error(`${table.id} has no staging contract.`);
  const stream = streamById.get(table.id);
  if (!stream) throw new Error(`${table.id} has no stream contract.`);
  return {
    id: table.id,
    domain: table.domain,
    additivity: table.additivity,
    primaryKey: table.primaryKey,
    recordIdField: table.recordIdField,
    availability: stream.availability ?? "required",
    deletionStrategy: stream.deletionStrategy,
    // Every physical column of source_lightspeed.<table>, in DDL order, with
    // the vendor field it is projected from. The Fivetran table lands the
    // identical shape so the ls_* views re-point with a schema change only.
    columns: contract.fields.map((field) => ({
      column: field.column,
      field: field.sourceField,
      type: field.type,
    })),
  };
}

const plan = LIGHTSPEED_SCAN_PLAN;

const groups = plan.groups.map((group) => {
  const scan = resolveStreamScan(streamById.get(group.leader.id)!);
  const modified = group.leader.pushdowns.find((pushdown) => /^(timeStamp|updateTime)$/u.test(pushdown.param))?.param ?? null;
  const members = group.members.map((member) => {
    const memberScan = resolveStreamScan(streamById.get(member.table.id)!);
    const resource = ownResource(member.table, group.resource);
    // Parent-context leaves a nested row carries (Sale.completed on a sale line).
    const parentLeaves = memberScan.projectFrom
      ? [...new Set(member.table.columns
        .filter((column) => apiOwner(column.api) === group.resource && apiOwner(column.api) !== resource)
        .map((column) => column.api.split(".").pop()!)
        .filter(Boolean))]
      : [];
    return {
      table: member.table.id,
      resource,
      projectFrom: memberScan.projectFrom,
      recordIdField: member.table.recordIdField,
      parentLeaves,
    };
  });
  const neededRoots = new Set<string>(members.flatMap((member) => [
    ...(member.projectFrom ? [member.projectFrom.split(".")[0]!] : []),
    ...member.parentLeaves,
    ...byId.get(member.table)!.columns.map((column) => column.api.split(".").pop()!),
  ]));
  // Only REQUIRED member tables (the ones with canonical mappers — sale
  // lines/payments, item shops, order lines…) may reject a page when their
  // relation root is missing from every record. Optional enrichment tables
  // (CCGateway, ReceiptSetup, CustomFieldValues, Note, ItemPrices…) are
  // legitimately empty on many accounts — live fire: Shop.CCGateway absent
  // on every shop, Item.ItemPrices absent on every item.
  const requiredRoots = [...new Set(group.members
    .filter((member) => member.projection === "nested" && member.projectFrom)
    .filter((member) => (streamById.get(member.table.id)?.availability ?? "required") === "required")
    .map((member) => member.projectFrom!.split(".")[0]!)
    .filter((root) => scan.relations.some((relation) => relation.split(".")[0] === root))
    .filter((root) => !SPARSE_RELATIONS.includes(`${group.resource}.${root}`)))];
  const leaderStream = streamById.get(group.leader.id)!;
  const dateRange = group.leader.pushdowns.some((pushdown) => pushdown.param === "startDate,endDate");
  const appendOnlyById = leaderStream.deletionStrategy === "immutable_append_only"
    && group.keysetCapable
    && /ID$/u.test(group.idField);
  // GET /API/V3/Account.json is a singleton above the account path: it takes
  // no paging, sorting or load_relations (live: 400 "Tried to load one or
  // more relations that are not allowed: purchasingCurrencies"); its nested
  // members are read from the record as returned.
  const singleton = group.resource === "Account";
  return {
    resource: group.resource,
    path: group.path,
    idField: group.idField,
    keysetCapable: group.keysetCapable,
    leader: group.leader.id,
    members,
    singleton,
    // Only the relations the projection can actually read: the roots nested
    // members project from, and relations that are themselves a staged jsonb
    // column (Customer.Contact). Enrichment relations the worker also loads
    // (Item.Category, Sale.Customer …) never reach a staged column — the
    // projection reads leaf keys of the walked record — and live fire showed
    // that a long relation list makes R-Series silently drop some
    // (Item.json returned no ItemPrices on any record with 11 relations).
    relations: singleton ? [] : scan.relations.filter((relation) => neededRoots.has(relation.split(".")[0]!)),
    extraParamSets: scan.extraParamSets,
    modifiedParam: modified,
    // How the second and later syncs narrow the walk: by the vendor's
    // last-modified filter where the leader has one; by the required
    // startDate/endDate pair on the by-day report endpoints; by immutable
    // ascending id for append-only ledgers without a modified field
    // (InventoryLog, voids, withdraws); else a full re-snapshot, which is what
    // the worker does for the same tables.
    incremental: modified ? "modified" : dateRange ? "date_range" : appendOnlyById ? "id_keyset" : "full",
    requiredRoots: singleton ? [] : requiredRoots,
    availability: leaderStream.availability ?? "required",
  };
});

const fanOuts = plan.fanOuts.map((fanOut) => {
  const scan = resolveStreamScan(streamById.get(fanOut.table.id)!);
  return {
    table: fanOut.table.id,
    resource: ownResource(fanOut.table, scan.group.resource),
    parentResource: scan.group.resource,
    parentPath: scan.group.path,
    parentIdField: scan.fanOut!.parentIdField,
    endpointTemplate: scan.fanOut!.endpointTemplate,
    recordIdField: fanOut.table.recordIdField,
    // One sub-request per parent record. Registers and custom fields number in
    // the tens, so those fan-outs run every sync; a per-workorder image walk
    // is one request per workorder ever raised and is opt-in.
    alwaysOn: ["Register", "CustomField"].includes(scan.group.resource),
  };
});

const spec = {
  revision: `${lightspeedRManifest.packVersion} (${lightspeedRManifest.apiVersion})`,
  tables: Object.fromEntries(SPEC_TABLES.map((table) => [table.id, tableLiteral(table)])),
  groups,
  fanOuts,
};

const specJson = JSON.stringify(spec, null, 1);
const specHash = createHash("sha256").update(specJson).digest("hex");
const py = `# GENERATED FILE — do not edit.
# Source: connectors/lightspeed-r/tables.json (pack ${lightspeedRManifest.packVersion}) via
# scripts/generate-fivetran-lightspeed-sdk-spec.ts. Regenerate with:
#   npx tsx scripts/generate-fivetran-lightspeed-sdk-spec.ts
import json

SPEC_SHA256 = "${specHash}"

SPEC = json.loads(r'''${specJson.replace(/'''/g, "'\\''\\''")}''')
`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(resolve(OUT_DIR, "lightspeed_spec.py"), py);

/* ------------------------------------------------------------------ */
/* Parity fixture: nested walk pages + the reference projection.        */
/* ------------------------------------------------------------------ */
const recording = JSON.parse(readFileSync(resolve("connectors/lightspeed-r/fixtures/sanitized-recording.json"), "utf8")) as {
  responses: Record<string, Record<string, unknown>>;
};

function envelopeKey(body: Record<string, unknown>): string | null {
  return Object.keys(body).find((key) => key !== "@attributes") ?? null;
}

function setPath(target: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[segments[segments.length - 1]!] = value;
}

/** One walk page per group: the leader's recorded records with every nested member grafted in. */
const walkPages: Record<string, unknown> = {};
const expected: Record<string, unknown[]> = {};

for (const group of plan.groups) {
  const leaderBody = recording.responses[group.leader.id];
  if (!leaderBody) continue;
  const leaderRecords = parseEnvelope(leaderBody, group.resource).records.map((record) => ({ ...record }));
  for (const member of group.members) {
    if (member.table.id === group.leader.id || !member.projectFrom) continue;
    const memberBody = recording.responses[member.table.id];
    if (!memberBody) continue;
    const key = envelopeKey(memberBody);
    if (!key) continue;
    const children = parseEnvelope(memberBody, key).records;
    const segments = member.projectFrom.split(".");
    // Graft at the deepest segment the recorded envelope names (a recorded
    // Contact already nests its Emails), else at the full path.
    const at = segments.lastIndexOf(key);
    const graftSegments = at >= 0 ? segments.slice(0, at + 1) : segments;
    for (const record of leaderRecords) {
      const existing = graftSegments.reduce<unknown>((cur, seg) =>
        cur && typeof cur === "object" ? (cur as Record<string, unknown>)[seg] : undefined, record);
      if (existing !== undefined) continue;
      setPath(record, graftSegments, children.length === 1 ? children[0] : children);
    }
  }
  const page = { "@attributes": { count: String(leaderRecords.length) }, [group.resource]: leaderRecords };
  walkPages[group.resource] = page;
  const records = parseEnvelope(page, group.resource).records;
  for (const member of group.members) {
    // A table walked by several groups (ls_contacts under Customer,
    // CreditAccount and ShipTo) resolves to its first group in the worker;
    // the SDK projects it from every walk, so pin the scan to THIS group.
    const scan = { ...resolveStreamScan(streamById.get(member.table.id)!), group };
    const rows = projectStreamRows(scan, records, (payload) => hashPayload(payload));
    const allowed = new Set(byId.get(member.table.id)!.columns.map((column) => column.api.split(".").pop()!));
    // Keyed by walk and table: ls_contacts is projected by three walks.
    expected[`${group.resource}/${member.table.id}`] = rows.map((row) => ({
      sourceRecordId: row.sourceRecordId,
      sourceObjectType: row.sourceObjectType,
      updatedAt: row.sourceUpdatedAt ?? null,
      fields: Object.fromEntries(Object.entries(row.payload as Record<string, unknown>).filter(([field]) => allowed.has(field))),
    }));
  }
}

mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(resolve(FIXTURE_DIR, "walk_pages.json"), JSON.stringify(walkPages, null, 1));
writeFileSync(resolve(FIXTURE_DIR, "expected_projection.json"), JSON.stringify(expected, null, 1));

console.log(`lightspeed_spec.py: ${groups.length} groups, ${fanOuts.length} fan-outs, ${Object.keys(spec.tables).length} tables (sha256 ${specHash.slice(0, 12)})`);
console.log(`expected_projection.json: ${Object.keys(expected).length} tables from ${Object.keys(walkPages).length} walk pages`);
