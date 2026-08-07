/**
 * Spec-driven sync for all 90 Lightspeed streams.
 *
 * The worker resolves a staging table from the stream being synced, not from a
 * record's own type (`prepareTypedStaging(connectorId, manifest.stream, ...)`),
 * so a page can only ever fill its own stream's table. A leader therefore
 * cannot emit its children's rows, and each stream owns its own walk.
 *
 * What that costs is duplication: `ls_sales` and `ls_sale_lines` both walk
 * `Sale.json`. What it buys is that every stream is independently resumable,
 * independently verifiable, and correct under the existing worker contract with
 * no changes to it. Each walk requests only the relations that stream actually
 * projects from, so the duplicated requests are as cheap as they can be.
 *
 * A future optimisation is to serve derived streams from the leader's stored
 * raw payloads instead of the API — the payloads are already immutable in
 * object storage — but that needs the connector to reach storage, which the
 * `ConnectorContext` deliberately does not expose today.
 */
import { ConnectorError } from "../../packages/connector-sdk/src/errors.js";
import type {
  RawSourceRecord,
  SyncCursor,
  SyncPage,
  SyncRange,
} from "../../packages/connector-sdk/src/index.js";
import { decodeCursor, encodeCursor } from "../../packages/connector-sdk/src/cursor.js";
import {
  MAX_PAGE_SIZE,
  afterTokenFrom,
  assertRelationsPresent,
  evaluatePagination,
  parseEnvelope,
  readSourceUpdatedAt,
  resolvePath,
} from "./fetch-core.js";
import { buildScanPlan, collapseRelations, type ScanGroup, type SpecTable } from "./scan-plan.js";
import { apiOwner, ownResource, type LightspeedStream } from "./streams.js";

const PLAN = buildScanPlan();

/** The group a stream walks, plus how that stream projects its own rows. */
export type StreamScan = Readonly<{
  group: ScanGroup;
  table: SpecTable;
  /**
   * A parent-scoped endpoint with no account-wide alias. Its rows can only be
   * reached one parent at a time, so the walk pages the parent resource and
   * issues one sub-request per parent record. Expensive by construction, which
   * is why these streams are declared optional.
   */
  fanOut: Readonly<{ endpointTemplate: string; parentIdField: string }> | null;
  /** Dot path to this stream's rows; null when it projects records 1:1. */
  projectFrom: string | null;
  /** Only the relations this stream needs, not the whole group union. */
  relations: readonly string[];
  /** Extra parameter passes that reveal hidden populations. */
  extraParamSets: readonly Readonly<Record<string, string>>[];
}>;

/**
 * Resolve what one stream must fetch. Relations are narrowed to this stream's
 * own needs: asking for the group's full union on every member would multiply
 * payload size and push each request closer to the documented
 * memory-exhaustion 500.
 */
export function resolveStreamScan(stream: LightspeedStream): StreamScan {
  const group = PLAN.groups.find((candidate) => candidate.resource === stream.scanResource);
  if (!group) {
    throw new ConnectorError(
      "CONFIGURATION_INVALID",
      `Stream ${stream.id} names scan resource ${stream.scanResource}, which has no scan group.`,
    );
  }
  const fanOutPlan = PLAN.fanOuts.find((candidate) => candidate.table.id === stream.id);
  if (fanOutPlan) {
    return {
      group,
      table: fanOutPlan.table,
      fanOut: {
        endpointTemplate: fanOutPlan.endpoint.replace(/\s*\(.*$/, "").trim(),
        parentIdField: group.idField,
      },
      projectFrom: null,
      // The parent walk needs no relations: only its ids are used.
      relations: [],
      extraParamSets: [],
    };
  }

  const member = group.members.find((candidate) => candidate.table.id === stream.id);
  if (!member) {
    throw new ConnectorError(
      "CONFIGURATION_INVALID",
      `Stream ${stream.id} is not a member of scan group ${group.resource}.`,
    );
  }

  // The relation that carries this stream's rows, plus anything its own columns
  // resolve through. A leader needs none of the group's child relations.
  //
  // Every member of a group sends the IDENTICAL relation list: the union of
  // each member's own needs. Byte-identical requests are what let sibling
  // walks hit the page cache instead of the vendor — live fire showed each
  // member independently re-walking the full parent history (400 Sale pages
  // fetched to stage zero signature rows), a ~6x request multiplier on the
  // biggest resources.
  //
  // This is NOT the fifteen-relation nested union that 500d Sale.json and made
  // Item.json drop relations silently: that union carried every member's
  // deep enrichment paths (Item, TaxClass, InventorySales expansions per
  // line). The member-need union stays at bare projection roots plus the
  // leader's own enrichments — for Sale exactly the Customer + SaleLines +
  // SalePayments trio the 13-stream pack walked in production for months.
  // The relation-presence guard still rejects any page where a requested
  // root silently vanishes.
  const shared = new Set<string>();
  for (const sibling of group.members) {
    if (sibling.projectFrom) shared.add(sibling.projectFrom.split(".")[0] as string);
    for (const relation of sibling.table.loadRelations) {
      // Keep a relation only when it hangs off the record that sibling reads.
      if (!sibling.projectFrom) {
        shared.add(relation);
      } else if (relation.startsWith(`${sibling.projectFrom.split(".")[0]}.`)) {
        shared.add(relation);
      }
    }
  }
  // Parent-context columns resolve from the walked record itself and need no
  // relation of their own.
  return {
    group,
    table: member.table,
    fanOut: null,
    projectFrom: member.projectFrom,
    relations: collapseRelations([...shared]),
    extraParamSets: group.extraParamSets,
  };
}

export type ScanCursorState = Readonly<{
  /** Opaque vendor continuation for the page currently being walked. */
  after?: string;
  /** Index into extraParamSets: -1 is the default population. */
  pass?: number;
}>;

export type ScanWindow = Readonly<{
  /** Vendor-format modified-time filter, e.g. ">=,2026-08-01T00:00:00+00:00". */
  field: string;
  expression: string;
}>;

/** Build the query parameters for one page of one stream. */
export function pageParams(
  scan: StreamScan,
  state: ScanCursorState,
  window?: ScanWindow,
): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};

  if (state.after) {
    // The vendor bakes sort, filter and page size into the continuation. Sending
    // them again alongside it silently restarts the walk from the beginning.
    params.after = state.after;
  } else {
    params.limit = String(MAX_PAGE_SIZE);
    // Ascending primary id: records created mid-walk take higher ids and land at
    // the end, so a long walk can never skip one.
    params.sort = scan.group.idField;
    // Incremental and late-edit sweeps push the modified-time bound down to the
    // vendor; without it every 15-minute incremental would re-walk the account.
    if (window) params[window.field] = window.expression;
  }

  if (scan.relations.length > 0) {
    params.load_relations = JSON.stringify(scan.relations);
  }

  const pass = state.pass ?? -1;
  if (pass >= 0) {
    const extra = scan.extraParamSets[pass];
    if (extra) for (const [key, value] of Object.entries(extra)) params[key] = value;
  }
  return params;
}

/**
 * Advance the pass counter once a population is exhausted. Hidden populations
 * (archived records, gift-card credit accounts) are separate passes rather than
 * a widened first pass, so a vendor that ignores the filter cannot silently
 * merge them into the default set.
 */
export function nextPass(scan: StreamScan, pass: number): number | null {
  const next = pass + 1;
  return next < scan.extraParamSets.length ? next : null;
}

/** Project one fetched page into this stream's rows only. */
export function projectStreamRows(
  scan: StreamScan,
  records: readonly Readonly<Record<string, unknown>>[],
  hash: (payload: unknown) => string,
): readonly RawSourceRecord[] {
  const out: RawSourceRecord[] = [];
  const idField = scan.table.recordIdField;
  // The stream's own resource, not the group's: rows are recorded and
  // referenced by (sourceObjectType, sourceRecordId), and a nested child that
  // kept its parent's resource would conflate Sale 5 with SaleLine 5.
  const resource = ownResource(scan.table, scan.group.resource);
  // Columns whose field lives on the walked parent are context a nested row
  // needs to map standalone (Sale.completed on a sale line). They resolve
  // from the walked record and ride the child payload under their leaf name.
  const parentColumns = scan.projectFrom
    ? scan.table.columns.filter((column) => apiOwner(column.api) === scan.group.resource
        && apiOwner(column.api) !== resource)
    : [];

  for (const record of records) {
    const rows = scan.projectFrom ? resolvePath(record, scan.projectFrom) : [record];
    for (const row of rows) {
      if (row === null || typeof row !== "object") continue;
      const payload = { ...(row as Record<string, unknown>) };
      for (const column of parentColumns) {
        const leaf = column.api.split(".").pop();
        if (!leaf || payload[leaf] !== undefined) continue;
        const value = (record as Record<string, unknown>)[leaf];
        if (value !== undefined) payload[leaf] = value;
      }

      const ownId = idField ? readId(payload, idField) : null;
      const parentId = readId(record, scan.group.idField);
      // A child whose uid is unique only within its parent, or a computed row
      // with no id at all, is keyed on the parent plus its position so that
      // re-running a window produces the same keys and never duplicates.
      const sourceRecordId =
        ownId ?? (parentId ? `${parentId}:${out.length}` : `${scan.table.id}:${out.length}`);

      const updatedAt = readSourceUpdatedAt(payload) ?? readSourceUpdatedAt(record);
      out.push({
        sourceObjectType: resource,
        sourceRecordId,
        ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {}),
        payload,
        // Hashed over the payload object with the same canonicalization the
        // raw-batch store uses to verify immutable payload bytes; hashing a
        // pre-serialized string here made every landed batch fail validation.
        payloadHash: hash(payload),
        normalized: {
          schemaVersion: "1",
          fields: payload,
        },
      });
    }
  }
  return out;
}

function vendorTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConnectorError("CURSOR_INVALID", "Lightspeed sync time is invalid.");
  }
  return new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, "+00:00");
}

function readId(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 && text !== "0" ? text : null;
}


export type PageFetcher = (
  path: string,
  params: Readonly<Record<string, string>>,
) => Promise<unknown>;


/**
 * Fetch and project one page for one stream, returning a SyncPage the worker
 * can commit. A page that cannot advance safely is reported as a structured
 * pagination block: the rows are retained as evidence and the cursor is NOT
 * committed, which is the difference between a stalled stream and an infinite
 * loop that looks like progress.
 */
export async function syncStreamPage(input: {
  stream: LightspeedStream;
  connectorId: "lightspeed-r";
  cursor?: SyncCursor;
  range?: SyncRange;
  mode: "initial" | "incremental" | "reconciliation";
  fetchPage: PageFetcher;
  hash: (payload: unknown) => string;
}): Promise<SyncPage> {
  const { stream, cursor, mode, fetchPage, hash } = input;
  const scan = resolveStreamScan(stream);

  const decoded = cursor
    ? decodeCursor(cursor, { connector: input.connectorId, stream: stream.id })
    : undefined;
  const state: ScanCursorState = decoded?.continuation
    ? (JSON.parse(String(decoded.continuation)) as ScanCursorState)
    : {};
  const pass = state.pass ?? -1;

  if (scan.fanOut) return syncFanOutPage(scan, state, input);

  // The modified-time bound is pushed to the vendor on the WALKED resource:
  // a member's own timestamps live under its parent, and it is the parent
  // walk the vendor filters. Inclusive boundaries are at-least-once delivery.
  const leaderModified = scan.group.leader.pushdowns.find((pushdown) =>
    /^(timeStamp|updateTime)$/.test(pushdown.param))?.param;
  const window = leaderModified
    ? input.mode === "incremental" && decoded?.watermark
      ? { field: leaderModified, expression: `>=,${vendorTime(decoded.watermark)}` }
      : input.mode !== "incremental" && input.range && stream.backfillStrategy === "time_windowed"
        ? { field: leaderModified, expression: `><,${vendorTime(input.range.from)},${vendorTime(input.range.to)}` }
        : undefined
    : undefined;

  const body = await fetchPage(scan.group.path, pageParams(scan, state, window));
  const page = parseEnvelope(body, scan.group.resource);

  // A relation-free response is a silent disaster: the walk succeeds and this
  // stream's table stages nothing. Reject the page rather than commit it.
  // Assert only the relation roots THIS walk requested: each member's walk is
  // narrowed to its own relations, so sibling members' roots are legitimately
  // absent from the response and must not fail the page.
  if (scan.projectFrom) {
    assertRelationsPresent(scan.group, page.records, scan.relations);
  }

  const records = projectStreamRows(scan, page.records, hash);
  const pagination = evaluatePagination(state.after ?? null, page.nextUrl, page.records.length);

  if (pagination.block) {
    return { records, nextCursor: null, hasMore: false, paginationBlock: pagination.block };
  }

  // Population exhausted: move to the next hidden-population pass, if any.
  let nextState: ScanCursorState | null = null;
  if (pagination.nextAfter) {
    nextState = { after: pagination.nextAfter, pass };
  } else {
    const following = nextPass(scan, pass);
    if (following !== null) nextState = { pass: following };
  }

  const watermark = latest(records.map((record) => record.sourceUpdatedAt), decoded?.watermark);

  return {
    records,
    hasMore: nextState !== null,
    nextCursor: encodeCursor({
      v: 1,
      connector: input.connectorId,
      stream: stream.id,
      mode: mode === "reconciliation" ? "reconciliation" : mode,
      ...(watermark ? { watermark } : {}),
      ...(nextState ? { continuation: JSON.stringify(nextState) } : {}),
    }),
    ...(nextState === null && mode === "initial"
      ? {
          coverage: {
            // Every population was walked to exhaustion by ascending id, so the
            // scan is exhaustive rather than merely vendor-reported.
            boundaryKind: records.length > 0 ? ("verified_oldest" as const) : ("verified_empty" as const),
            lowerBound: watermark ?? new Date(0).toISOString(),
            verification: "exhaustive_vendor_scan" as const,
          },
        }
      : {}),
  };
}

/**
 * One page of a parent-scoped stream: page the parent, then issue one
 * sub-request per parent record. The cursor carries only the parent
 * continuation, so a crash resumes at the parent page rather than replaying
 * every sub-request from the start.
 */
async function syncFanOutPage(
  scan: StreamScan,
  state: ScanCursorState,
  input: {
    stream: LightspeedStream;
    connectorId: "lightspeed-r";
    mode: "initial" | "incremental" | "reconciliation";
    fetchPage: PageFetcher;
    hash: (payload: unknown) => string;
  },
): Promise<SyncPage> {
  const { fetchPage, hash } = input;
  const parentParams: Record<string, string> = state.after
    ? { after: state.after }
    : { limit: String(MAX_PAGE_SIZE), sort: scan.group.idField };

  const parentBody = await fetchPage(scan.group.path, parentParams);
  const parentPage = parseEnvelope(parentBody, scan.group.resource);

  const rows: RawSourceRecord[] = [];
  for (const parent of parentPage.records) {
    const parentId = readId(parent, scan.fanOut!.parentIdField);
    if (!parentId) continue;
    const path = scan.fanOut!.endpointTemplate.replace(/\{[A-Za-z]+\}/, encodeURIComponent(parentId));
    const childBody = await fetchPage(path, {});
    const childPage = parseEnvelope(childBody, scan.table.recordIdField ? scan.group.resource : scan.group.resource);
    for (const child of childPage.records) {
      const ownId = scan.table.recordIdField ? readId(child, scan.table.recordIdField) : null;
      rows.push({
        sourceObjectType: ownResource(scan.table, scan.group.resource),
        sourceRecordId: ownId ?? `${parentId}:${rows.length}`,
        ...(readSourceUpdatedAt(child) ? { sourceUpdatedAt: readSourceUpdatedAt(child)! } : {}),
        payload: child,
        payloadHash: hash(child),
        normalized: { schemaVersion: "1", fields: child },
      });
    }
  }

  const pagination = evaluatePagination(state.after ?? null, parentPage.nextUrl, parentPage.records.length);
  if (pagination.block) {
    return { records: rows, nextCursor: null, hasMore: false, paginationBlock: pagination.block };
  }
  const nextState = pagination.nextAfter ? { after: pagination.nextAfter } : null;
  return {
    records: rows,
    hasMore: nextState !== null,
    nextCursor: encodeCursor({
      v: 1,
      connector: input.connectorId,
      stream: input.stream.id,
      mode: input.mode === "reconciliation" ? "reconciliation" : input.mode,
      ...(nextState ? { continuation: JSON.stringify(nextState) } : {}),
    }),
    ...(nextState === null && input.mode === "initial"
      ? {
          coverage: {
            boundaryKind: rows.length > 0 ? ("verified_oldest" as const) : ("verified_empty" as const),
            lowerBound: new Date(0).toISOString(),
            verification: "exhaustive_vendor_scan" as const,
          },
        }
      : {}),
  };
}

function latest(
  values: readonly (string | undefined)[],
  previous?: string,
): string | undefined {
  let best = previous;
  for (const value of values) {
    if (!value) continue;
    if (!best || Date.parse(value) > Date.parse(best)) best = value;
  }
  return best;
}

/** Every stream the connector can sync, for the manifest and the worker. */
export { PLAN as LIGHTSPEED_SCAN_PLAN };
