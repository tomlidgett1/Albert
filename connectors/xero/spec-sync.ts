/**
 * Spec-driven sync for every Xero stream.
 *
 * The worker resolves a staging table from the stream being synced, so a page
 * can only ever fill its own stream's table: each stream owns its walk, nested
 * streams re-walk their leader's endpoint and project their own rows, and
 * fan-out streams iterate parent ids one sub-request at a time under the org's
 * daily budget. What that costs in duplicate requests it buys back in
 * independent resumability — and Xero's page cache makes the duplicate walks
 * cheap relative to the correctness they guarantee.
 *
 * Projection is column-driven: every spec column's provenance path is resolved
 * against the walked record (or exploded element), so the normalized row
 * carries exactly the fields the staging contract stages. Xero's legacy
 * `/Date(ms+tz)/` values are normalized to ISO before landing because typed
 * staging casts them to timestamptz.
 */
import type { RawSourceRecord } from "../../packages/connector-sdk/src/index.js";
import {
  hashPayload,
  projectSourceRecord,
} from "../../packages/connector-sdk/src/index.js";
import {
  XERO_SCAN_PLAN,
  xeroSourceField,
  type XeroFanOutScan,
  type XeroScanGroup,
  type XeroSpecColumn,
  type XeroSpecTable,
} from "./scan-plan.js";
import type { XeroStream } from "./streams.js";

/** Per-API transport conventions, verified against the pinned OpenAPI ops. */
export type XeroApiProfile = Readonly<{
  basePath: string;
  pageParam: string | null;
  pageSizeParam: string | null;
  pageSize: number;
  supportsIfModifiedSince: boolean;
  supportsWhere: boolean;
  supportsOrder: boolean;
}>;

export const XERO_API_PROFILES: Readonly<Record<XeroSpecTable["source"]["api"], XeroApiProfile>> = {
  accounting: {
    basePath: "/api.xro/2.0",
    pageParam: "page",
    pageSizeParam: "pageSize",
    pageSize: 1_000,
    supportsIfModifiedSince: true,
    supportsWhere: true,
    supportsOrder: true,
  },
  assets: {
    basePath: "/assets.xro/1.0",
    pageParam: "page",
    pageSizeParam: "pageSize",
    pageSize: 100,
    supportsIfModifiedSince: false,
    supportsWhere: false,
    supportsOrder: false,
  },
  projects: {
    basePath: "/projects.xro/2.0",
    pageParam: "page",
    pageSizeParam: "pageSize",
    pageSize: 50,
    supportsIfModifiedSince: false,
    supportsWhere: false,
    supportsOrder: false,
  },
  files: {
    basePath: "/files.xro/1.0",
    pageParam: "page",
    pageSizeParam: "pagesize",
    pageSize: 100,
    supportsIfModifiedSince: false,
    supportsWhere: false,
    supportsOrder: false,
  },
  payroll_au: {
    basePath: "/payroll.xro/1.0",
    pageParam: "page",
    pageSizeParam: null,
    pageSize: 100,
    supportsIfModifiedSince: true,
    // Payroll AU v1 answers HTTP 500 (no error body) to ANY `where=` clause
    // (verified live 2026-08-20: order-only 200, where-only 500). The 500
    // looked like an outage, was retried, and burned ~70 daily API calls per
    // sync. If-Modified-Since is the supported incremental mechanism here.
    supportsWhere: false,
    supportsOrder: true,
  },
  payroll_uk: {
    basePath: "/payroll.xro/2.0",
    pageParam: "page",
    pageSizeParam: null,
    pageSize: 100,
    supportsIfModifiedSince: false,
    supportsWhere: false,
    supportsOrder: false,
  },
  payroll_nz: {
    basePath: "/payroll.xro/2.0",
    pageParam: "page",
    pageSizeParam: null,
    pageSize: 100,
    supportsIfModifiedSince: false,
    supportsWhere: false,
    supportsOrder: false,
  },
  identity: {
    basePath: "",
    pageParam: null,
    pageSizeParam: null,
    pageSize: 0,
    supportsIfModifiedSince: false,
    supportsWhere: false,
    supportsOrder: false,
  },
};

/**
 * Accounting ops that accept `unitdp=4`. Requesting four decimal places is how
 * the pack preserves Xero's full monetary precision instead of the 2dp default.
 */
const UNITDP_OPS = new Set([
  "GET /BankTransactions",
  "GET /CreditNotes",
  "GET /Invoices",
  "GET /Items",
  "GET /Overpayments",
  "GET /Prepayments",
  "GET /Receipts",
]);

/**
 * Populations hidden behind an explicit parameter. Assets require a status
 * filter — there is no "all" — so registered, draft and disposed assets are
 * separate passes; contacts include archived records so merge/archive truth is
 * never lost; bank transfers include deleted legs; 1099 reports are one pass
 * per calendar year the report can still be amended for.
 */
export function extraParamPasses(table: XeroSpecTable, nowIso: string): readonly Readonly<Record<string, string>>[] {
  if (table.source.endpointOp === "GET /Assets") {
    return [{ status: "REGISTERED" }, { status: "DRAFT" }, { status: "DISPOSED" }];
  }
  if (table.source.endpointOp === "GET /Reports/TenNinetyNine") {
    const year = Number(nowIso.slice(0, 4));
    // 1099s are filed for the prior year and amendable for three more.
    return [0, 1, 2, 3].map((offset) => ({ reportYear: String(year - 1 - offset) }));
  }
  return [];
}

/** Always-on query parameters for an endpoint walk. */
export function baseParams(table: XeroSpecTable): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};
  if (table.source.api === "accounting") {
    if (UNITDP_OPS.has(rootOp(table.source.endpointOp))) params.unitdp = "4";
    if (table.source.endpointOp === "GET /Contacts") params.includeArchived = "true";
    if (table.source.endpointOp === "GET /BankTransfers") params.includeDeleted = "true";
  }
  return params;
}

function rootOp(endpointOp: string): string {
  return endpointOp;
}

/** The URL path for an endpoint op, relative to the API origin. */
export function endpointPath(table: XeroSpecTable): string {
  const profile = XERO_API_PROFILES[table.source.api];
  const path = table.source.endpointOp.replace(/^GET\s+/, "");
  if (table.source.api === "identity") return "/connections";
  return `${profile.basePath}${path}`;
}

/* ------------------------------------------------------------------ */
/* Projection                                                          */
/* ------------------------------------------------------------------ */

type JsonRecord = Readonly<Record<string, unknown>>;

const MS_DATE = /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/u;

/** Normalize Xero's legacy `/Date(ms+tz)/` values to ISO-8601. */
export function normalizeXeroValue(value: unknown): unknown {
  if (typeof value === "string") {
    const match = MS_DATE.exec(value);
    if (match) {
      const ms = Number(match[1]);
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return value;
}


/**
 * A synthetic column carries something real that simply is not in the response
 * body: a constant the endpoint implies, a request parameter the scan chose, or
 * the fan-out parent a sub-response belongs to. Left unresolved these columns
 * are null, and where one is part of the declared key the rows collide — four
 * yearly 1099 passes overwrite each other into a single identity.
 *
 * Resolution order, all stated by the citation itself:
 *   1. a quoted constant  — synthetic:constant 'AU_PAYROLL' ...
 *   2. a named value the caller supplied (reportYear, EmployeeID, parentId ...)
 *   3. the explode branch, for a discriminator between sibling arrays
 */
export function resolveSyntheticValue(
  column: XeroSpecColumn,
  explodePath: string | null,
  synthetics: Readonly<Record<string, unknown>>,
): unknown {
  const citation = column.api;

  const quoted = /'([^']+)'/u.exec(citation);
  if (quoted) return quoted[1];

  // Longest name first so `EmployeeID` wins over a bare `id`.
  const names = Object.keys(synthetics).sort((left, right) => right.length - left.length);
  for (const name of names) {
    const value = synthetics[name];
    if (value === undefined || value === null) continue;
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu");
    if (pattern.test(citation) || pattern.test(column.name)) return value;
  }

  if (explodePath && /discriminator|branch|scope/u.test(citation)) {
    return explodePath.split(".").pop() ?? null;
  }
  return undefined;
}

function resolveSegments(record: unknown, segments: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as JsonRecord)[segment];
  }
  return current;
}

/** One projected row: the element, plus every object enclosing it. */
export type ExplodedRow = Readonly<{
  element: unknown;
  /** Enclosing values, walked record first, immediate container last. */
  ancestors: readonly unknown[];
  /** Position within the innermost array. */
  ordinal: number;
  /**
   * Index at every array level, outermost first, ending at `ordinal`. Two
   * balances belonging to different budget lines differ here and nowhere else,
   * so this — not the ordinal alone — is what keeps their keys apart.
   */
  path: readonly number[];
}>;

/**
 * Expand an explode path into rows, descending through every array on the way.
 *
 * `Budget.BudgetLines.BudgetBalances` yields one row per balance while keeping
 * that balance's own line reachable — which is the only way a balance row can
 * carry the AccountID that makes it meaningful. Flattening the path in one step
 * would lose the line and silently collapse every account's budget together.
 */
export function explodeRows(record: unknown, segments: readonly string[]): readonly ExplodedRow[] {
  type Frontier = { value: unknown; ancestors: unknown[]; path: number[] };
  let frontier: Frontier[] = [{ value: record, ancestors: [], path: [] }];
  for (const segment of segments) {
    const next: Frontier[] = [];
    for (const item of frontier) {
      const wasArray = Array.isArray(item.value);
      const containers = wasArray ? (item.value as unknown[]) : [item.value];
      containers.forEach((container, index) => {
        if (container === null || container === undefined || typeof container !== "object") return;
        const child = (container as JsonRecord)[segment];
        if (child === null || child === undefined) return;
        next.push({
          value: child,
          ancestors: [...item.ancestors, container],
          path: wasArray ? [...item.path, index] : item.path,
        });
      });
    }
    frontier = next;
  }
  const rows: ExplodedRow[] = [];
  for (const item of frontier) {
    const elements = Array.isArray(item.value) ? (item.value as unknown[]) : [item.value];
    elements.forEach((element, ordinal) => {
      rows.push({ element, ancestors: item.ancestors, ordinal, path: [...item.path, ordinal] });
    });
  }
  return rows;
}

/**
 * Resolve one column against the projected element and (for explode tables)
 * its parent record. The provenance root decides which record the path walks:
 * a column rooted at the element's own object reads the element; one rooted at
 * the parent object reads the parent. Synthetic ordinal columns receive the
 * element's array position.
 */
export function resolveColumnValue(input: {
  column: XeroSpecColumn;
  /** Object name for the element, then for each enclosing level (innermost last). */
  levels: readonly Readonly<{ object: string | null; value: unknown }>[];
  ordinal: number;
  /** The table's explode path, when its rows are elements of a nested array. */
  explodePath?: string | null;
  /**
   * Values the response body cannot carry but the request knows: the parameters
   * the scan issued (reportYear, AsOfDate, EmployeeID), the fan-out parent it
   * was issued for, and the organisation it belongs to.
   */
  synthetics?: Readonly<Record<string, unknown>>;
}): unknown {
  const { column, levels, ordinal, explodePath, synthetics } = input;
  if (column.api.startsWith("synthetic:")) {
    if (/(_index|_ordinal|position)$/u.test(column.name) || /position|index|ordinal/u.test(column.api)) {
      return ordinal;
    }
    return resolveSyntheticValue(column, explodePath ?? null, synthetics ?? {});
  }
  const body = column.api.slice(column.api.indexOf(":") + 1).replace(/\[\]( index)?$/u, "");

  // A citation may address the field the way the document nests it —
  // `Invoice.LineItems.Quantity` — while the row being projected IS one of
  // those line items. Walking that path literally lands on the array and
  // resolves to nothing, so the explode prefix is stripped and the remainder
  // read from the element itself.
  if (explodePath && body.startsWith(`${explodePath}.`)) {
    const value = resolveSegments(levels[0]?.value, body.slice(explodePath.length + 1).split("."));
    if (value !== undefined) return normalizeXeroValue(value);
  }
  // The array itself, cited by a column that is not jsonb, is asking for this
  // row's position in it — the only scalar an array can honestly provide.
  if (explodePath && body === explodePath) {
    return column.type === "jsonb" ? undefined : ordinal;
  }

  const [root, ...segments] = body.split(".");
  if (segments.length === 0) return undefined;

  // Prefer the level whose object the citation names; fall back to the
  // innermost level that actually carries the field, so a design that names an
  // alias still resolves rather than staging silence.
  const named = levels.find((level) => level.object === root);
  const candidates = named ? [named, ...levels] : levels;
  for (const level of candidates) {
    const value = resolveSegments(level.value, segments);
    if (value !== undefined) return normalizeXeroValue(value);
  }
  // The citation may name an ENCLOSING object and then descend into it
  // (`Allocation.Overpayment.OverpaymentID` read from an allocation row).
  // Dropping the root loses that; retry the whole path against each level so
  // an upward reference resolves instead of staging a null key.
  for (const level of levels) {
    const value = resolveSegments(level.value, [root!, ...segments]);
    if (value !== undefined) return normalizeXeroValue(value);
  }
  return undefined;
}

function objectName(qualified: string): string {
  return qualified.slice(qualified.indexOf(":") + 1);
}

/** Build the normalized fields for one projected row. */
export function projectRowFields(
  table: XeroSpecTable,
  row: ExplodedRow,
  walkedRecord: unknown,
  fanOutParent: Readonly<{ record: unknown; table: XeroSpecTable }> | null,
  synthetics: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const chain = table.source.explodeChain ?? [];
  // Levels, innermost first: the element, then each enclosing container named
  // by the explode chain, then the walked record and any fan-out parent.
  const levels: { object: string | null; value: unknown }[] = [
    { object: chain.length > 0 ? chain[chain.length - 1]! : objectName(table.sourceObjects[0] ?? ""), value: row.element },
  ];
  for (let index = row.ancestors.length - 1; index >= 0; index -= 1) {
    levels.push({ object: chain[index] ?? null, value: row.ancestors[index] });
  }
  if (row.ancestors.length === 0 && table.source.explodePath) {
    levels.push({ object: chain[0] ?? null, value: walkedRecord });
  }
  if (fanOutParent) {
    levels.push({
      object: objectName(fanOutParent.table.sourceObjects[0] ?? ""),
      value: fanOutParent.record,
    });
  }

  const fields: Record<string, unknown> = {};
  for (const column of table.columns) {
    const value = resolveColumnValue({
      column, levels, ordinal: row.ordinal, explodePath: table.source.explodePath, synthetics,
    });
    if (value !== undefined) fields[xeroSourceField(column)] = value;
  }
  return fields;
}

/** Statuses that retire an identity at the source while staying visible. */
const TOMBSTONE_STATUSES = new Set(["ARCHIVED", "DELETED"]);

/**
 * Project one page of walked records into one stream's rows. Explode streams
 * yield one row per element of the declared array; ordinary streams yield one
 * row per record. Rows are keyed by their own vendor id when one exists, else
 * parent id plus position so a re-run of the same window produces identical
 * keys and can never duplicate.
 */
export function projectStreamRows(input: {
  table: XeroSpecTable;
  leaderTable: XeroSpecTable;
  resource: string;
  records: readonly unknown[];
  recordIdField: string;
  /**
   * For fan-out sub-responses: the parent record the sub-request was issued
   * for, so columns citing the parent's fields (contact id on CIS settings)
   * resolve against it.
   */
  fanOutParent?: Readonly<{ record: unknown; table: XeroSpecTable }>;
  /** Request-side values for synthetic columns (parameters, parent, org). */
  synthetics?: Readonly<Record<string, unknown>>;
}): readonly RawSourceRecord[] {
  const { table, leaderTable, resource, records, recordIdField, fanOutParent } = input;
  const synthetics = input.synthetics ?? {};
  const explode = table.source.explodePath;
  const rows: RawSourceRecord[] = [];

  for (const [recordIndex, record] of records.entries()) {
    if (record === null || typeof record !== "object") continue;
    const parentId = fanOutParent
      ? readIdentifier(fanOutParent.record as JsonRecord, leaderIdField(fanOutParent.table))
      : readIdentifier(record as JsonRecord, leaderIdField(leaderTable));
    // A record's own position in the response is part of its position. Without
    // it every id-less row of one parent keys as `<parentId>:0`, so a whole
    // sub-response collapses into a single identity.
    const exploded: readonly ExplodedRow[] = explode
      ? explodeRows(record, explode.split(".").slice(1))
      : [{ element: record, ancestors: [], ordinal: recordIndex, path: [recordIndex] }];

    for (const row of exploded) {
      if (row.element === null || typeof row.element === "undefined") continue;
      const fields = projectRowFields(
        table,
        row,
        record,
        fanOutParent ? { record: fanOutParent.record, table: fanOutParent.table } : null,
        synthetics,
      );
      // Identity follows the declared grain. A composite primary key means the
      // row is only unique across all of its parts — a contact address is keyed
      // by contact AND address type, and keying it on the type alone would make
      // every contact's PO box the same record and collapse them into one.
      const composite = compositeKey(table, fields);
      const ownId = composite
        ?? readIdentifier(fields, recordIdField)
        ?? readIdentifier(row.element as JsonRecord, recordIdField);
      // A child with no id of its own is keyed by its whole position: parent id
      // plus the index at every level, so a re-run of the same window produces
      // identical keys and two balances of different lines never collide.
      const positionKey = row.path.join(".");
      // Position is the last resort, and a bare page index is not stable: Xero
      // gives no ordering guarantee, so a re-run would hand row 3's identity to
      // whatever now sits third. Prefer any declared key part that resolved,
      // then the element's content, and only then position.
      const declaredKey = partialKey(table, fields);
      const sourceRecordId = ownId
        ?? (parentId ? `${parentId}:${declaredKey ?? positionKey}` : null)
        ?? (declaredKey ? `${table.id}:${declaredKey}` : null)
        ?? `${table.id}:${hashPayload(row.element).slice(0, 32)}`;
      const modifiedField = table.source.modifiedField ?? "";
      const updatedAt = timestampOf(fields[modifiedField] ?? undefined)
        ?? timestampOf(
          (record as JsonRecord)[modifiedField] === undefined
            ? undefined
            : normalizeXeroValue((record as JsonRecord)[modifiedField]),
        );
      const status = String(fields.Status ?? fields.ContactStatus ?? "");

      // Every numeric spec column rides through exact-decimal normalization so
      // a malformed vendor amount is a visible normalization issue, never a
      // silently coerced float.
      const money: Record<string, readonly [unknown, unknown?]> = {};
      for (const column of table.columns) {
        if (column.type === "numeric" || column.type === "integer" || column.type === "bigint" || column.type === "real") {
          const key = xeroSourceField(column);
          if (fields[key] !== undefined && fields[key] !== null) {
            money[key] = [fields[key], fields.CurrencyCode];
          }
        }
      }
      rows.push({
        sourceObjectType: resource,
        sourceRecordId,
        ...(updatedAt ? { sourceUpdatedAt: updatedAt } : {}),
        payload: (explode ? row.element : record) as Record<string, unknown>,
        payloadHash: hashPayload(explode ? row.element : record),
        normalized: projectSourceRecord({
          schemaVersion: "1",
          fields,
          money,
          timestamps: {
            source_updated_at: [fields[modifiedField] ?? null, undefined],
            event_date: [fields.Date ?? fields.JournalDate ?? null, undefined],
          },
          tombstone: TOMBSTONE_STATUSES.has(status),
        }),
      });
    }
  }
  return rows;
}


/**
 * The declared grain expressed as an identity, for tables whose key is more
 * than one column. Returns null when the key is single-column (the vendor id
 * path handles those) or when any part is absent, so a partially-populated row
 * falls back to positional keying instead of silently sharing an identity.
 */
function compositeKey(
  table: XeroSpecTable,
  fields: Readonly<Record<string, unknown>>,
): string | null {
  if (table.primaryKey.length < 2) return null;
  const parts: string[] = [];
  for (const columnName of table.primaryKey) {
    const column = table.columns.find((candidate) => candidate.name === columnName);
    if (!column) return null;
    const value = fields[xeroSourceField(column)];
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (text.length === 0) return null;
    parts.push(text);
  }
  return parts.join("|");
}


/**
 * As much of the declared key as actually resolved, for a row with no vendor
 * id. `compositeKey` requires every part; this accepts what is present so a
 * natural key (an entitlement's Name) is used ahead of an unstable position.
 */
function partialKey(
  table: XeroSpecTable,
  fields: Readonly<Record<string, unknown>>,
): string | null {
  const parts: string[] = [];
  for (const columnName of table.primaryKey) {
    const column = table.columns.find((candidate) => candidate.name === columnName);
    if (!column) continue;
    const value = fields[xeroSourceField(column)];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text.length > 0) parts.push(text);
  }
  return parts.length > 0 ? parts.join("|") : null;
}

function leaderIdField(leader: XeroSpecTable): string {
  return leader.recordIdField ?? leader.primaryKey[0] ?? "";
}

function readIdentifier(record: JsonRecord | Record<string, unknown>, field: string): string | null {
  if (!field) return null;
  const value = (record as JsonRecord)[field];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function timestampOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/* ------------------------------------------------------------------ */
/* Envelope handling                                                   */
/* ------------------------------------------------------------------ */

/**
 * Unwrap a Xero response envelope into its record array. Accounting wraps
 * records under the resource key; v2 payroll wraps a single payload under a
 * lowercase key with pagination alongside; identity returns a bare array.
 */
export function unwrapEnvelope(body: unknown, table: XeroSpecTable): readonly unknown[] {
  if (Array.isArray(body)) return body;
  if (body === null || typeof body !== "object") return [];
  const record = body as JsonRecord;
  const arrayKey = table.source.arrayKey;
  if (arrayKey) {
    // Dotted keys walk into the envelope (AU `PayItems.EarningsRates`); each
    // segment also tries its lowercase-initial form because v2 payroll
    // single-GET wrappers carry payloads under lowercased keys.
    let current: unknown = record;
    for (const segment of arrayKey.split(".")) {
      if (current === null || typeof current !== "object" || Array.isArray(current)) { current = undefined; break; }
      const host = current as JsonRecord;
      current = host[segment] ?? host[segment.charAt(0).toLowerCase() + segment.slice(1)];
    }
    if (Array.isArray(current)) return current;
    if (current && typeof current === "object") return [current];
  }
  // Fall back to the first array-valued property — the envelope's payload —
  // rather than silently returning nothing.
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* Fan-out planning                                                    */
/* ------------------------------------------------------------------ */

export type FanOutRequest = Readonly<{
  path: string;
  params: Readonly<Record<string, string>>;
  parentId: string;
}>;

/**
 * Requests needed to cover one parent page for a fan-out stream. The fan-out
 * parameter is substituted into the path when the endpoint declares it there,
 * or sent as a query parameter otherwise (UK/NZ `Payslips?PayRunID=`).
 * Parent ids come from the parent record's own id field when the parameter
 * names it, else from any id-bearing array in the parent payload (AU pay-run
 * payslip stubs).
 */
export function fanOutRequests(
  fanOut: XeroFanOutScan,
  parentRecords: readonly unknown[],
  parentTable: XeroSpecTable,
): readonly FanOutRequest[] {
  const path = endpointPath(fanOut.table);
  const usesPathParam = path.includes(`{${fanOut.fanOutParam}}`);
  const requests: FanOutRequest[] = [];
  const seen = new Set<string>();

  for (const parent of parentRecords) {
    if (parent === null || typeof parent !== "object") continue;
    const record = parent as JsonRecord;
    const ids: string[] = [];
    const own = readIdentifier(record, fanOut.fanOutParam);
    if (own) {
      ids.push(own);
    } else if (fanOut.fanOutParam === (parentTable.recordIdField ?? "")) {
      const viaRecordId = readIdentifier(record, parentTable.recordIdField ?? "");
      if (viaRecordId) ids.push(viaRecordId);
    } else {
      // Search one level of arrays for stubs carrying the parameter
      // (PayRun.Payslips[].PayslipID).
      for (const value of Object.values(record)) {
        if (!Array.isArray(value)) continue;
        for (const stub of value) {
          if (stub && typeof stub === "object") {
            const id = readIdentifier(stub as JsonRecord, fanOut.fanOutParam);
            if (id) ids.push(id);
          }
        }
      }
      if (ids.length === 0) {
        const fallback = readIdentifier(record, parentTable.recordIdField ?? "");
        if (fallback) ids.push(fallback);
      }
    }

    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      requests.push(
        usesPathParam
          ? { path: path.replace(`{${fanOut.fanOutParam}}`, encodeURIComponent(id)), params: {}, parentId: id }
          : { path, params: { [fanOut.fanOutParam]: id }, parentId: id },
      );
    }
  }
  return requests;
}

/**
 * Whether a fan-out sub-request for this parent record can be skipped without
 * losing data. Attachment endpoints are only populated when the parent says it
 * has attachments — every skipped request is budget returned to real work.
 */
export function fanOutSkippable(fanOut: XeroFanOutScan, parent: unknown): boolean {
  if (!/\/Attachments$/u.test(fanOut.table.source.endpointOp)) return false;
  if (parent === null || typeof parent !== "object") return false;
  const flag = (parent as JsonRecord).HasAttachments;
  return flag === false;
}

/* ------------------------------------------------------------------ */
/* Cross-parent (templated) fan-outs: attachments and history          */
/* ------------------------------------------------------------------ */

export type XeroTemplatedParent = Readonly<{
  /** The parent collection walk, e.g. `GET /Invoices`. */
  endpointOp: string;
  /** The concrete sub-resource path template, e.g. `/Invoices/{InvoiceID}/Attachments`. */
  pathTemplate: string;
  /** The path parameter carrying the parent id. */
  idParam: string;
}>;

/**
 * Every parent endpoint documenting `/{id}/Attachments`, verbatim from the
 * pinned accounting OpenAPI. Parents advertise attachments via HasAttachments,
 * so the walk only spends sub-requests where the flag is true.
 */
export const XERO_ATTACHMENT_PARENTS: readonly XeroTemplatedParent[] = [
  { endpointOp: "GET /Accounts", pathTemplate: "/Accounts/{AccountID}/Attachments", idParam: "AccountID" },
  { endpointOp: "GET /BankTransactions", pathTemplate: "/BankTransactions/{BankTransactionID}/Attachments", idParam: "BankTransactionID" },
  { endpointOp: "GET /BankTransfers", pathTemplate: "/BankTransfers/{BankTransferID}/Attachments", idParam: "BankTransferID" },
  { endpointOp: "GET /Contacts", pathTemplate: "/Contacts/{ContactID}/Attachments", idParam: "ContactID" },
  { endpointOp: "GET /CreditNotes", pathTemplate: "/CreditNotes/{CreditNoteID}/Attachments", idParam: "CreditNoteID" },
  { endpointOp: "GET /Invoices", pathTemplate: "/Invoices/{InvoiceID}/Attachments", idParam: "InvoiceID" },
  { endpointOp: "GET /ManualJournals", pathTemplate: "/ManualJournals/{ManualJournalID}/Attachments", idParam: "ManualJournalID" },
  { endpointOp: "GET /PurchaseOrders", pathTemplate: "/PurchaseOrders/{PurchaseOrderID}/Attachments", idParam: "PurchaseOrderID" },
  { endpointOp: "GET /Quotes", pathTemplate: "/Quotes/{QuoteID}/Attachments", idParam: "QuoteID" },
  { endpointOp: "GET /Receipts", pathTemplate: "/Receipts/{ReceiptID}/Attachments", idParam: "ReceiptID" },
  { endpointOp: "GET /RepeatingInvoices", pathTemplate: "/RepeatingInvoices/{RepeatingInvoiceID}/Attachments", idParam: "RepeatingInvoiceID" },
];

/** Every parent endpoint documenting `/{id}/History`, verbatim from the spec. */
export const XERO_HISTORY_PARENTS: readonly XeroTemplatedParent[] = [
  { endpointOp: "GET /BankTransactions", pathTemplate: "/BankTransactions/{BankTransactionID}/History", idParam: "BankTransactionID" },
  { endpointOp: "GET /BankTransfers", pathTemplate: "/BankTransfers/{BankTransferID}/History", idParam: "BankTransferID" },
  { endpointOp: "GET /BatchPayments", pathTemplate: "/BatchPayments/{BatchPaymentID}/History", idParam: "BatchPaymentID" },
  { endpointOp: "GET /Contacts", pathTemplate: "/Contacts/{ContactID}/History", idParam: "ContactID" },
  { endpointOp: "GET /CreditNotes", pathTemplate: "/CreditNotes/{CreditNoteID}/History", idParam: "CreditNoteID" },
  { endpointOp: "GET /ExpenseClaims", pathTemplate: "/ExpenseClaims/{ExpenseClaimID}/History", idParam: "ExpenseClaimID" },
  { endpointOp: "GET /Invoices", pathTemplate: "/Invoices/{InvoiceID}/History", idParam: "InvoiceID" },
  { endpointOp: "GET /Items", pathTemplate: "/Items/{ItemID}/History", idParam: "ItemID" },
  { endpointOp: "GET /ManualJournals", pathTemplate: "/ManualJournals/{ManualJournalID}/History", idParam: "ManualJournalID" },
  { endpointOp: "GET /Overpayments", pathTemplate: "/Overpayments/{OverpaymentID}/History", idParam: "OverpaymentID" },
  { endpointOp: "GET /Payments", pathTemplate: "/Payments/{PaymentID}/History", idParam: "PaymentID" },
  { endpointOp: "GET /Prepayments", pathTemplate: "/Prepayments/{PrepaymentID}/History", idParam: "PrepaymentID" },
  { endpointOp: "GET /PurchaseOrders", pathTemplate: "/PurchaseOrders/{PurchaseOrderID}/History", idParam: "PurchaseOrderID" },
  { endpointOp: "GET /Quotes", pathTemplate: "/Quotes/{QuoteID}/History", idParam: "QuoteID" },
  { endpointOp: "GET /Receipts", pathTemplate: "/Receipts/{ReceiptID}/History", idParam: "ReceiptID" },
  { endpointOp: "GET /RepeatingInvoices", pathTemplate: "/RepeatingInvoices/{RepeatingInvoiceID}/History", idParam: "RepeatingInvoiceID" },
];


/**
 * Every id a parent record can supply for a fan-out parameter.
 *
 * Xero does not always name the id the way the sub-resource path does — a pay
 * run carries its payslips as stubs, and some parents name their key after the
 * object rather than the parameter. The fallback chain is: the parameter itself,
 * then the parent's declared record id, then id-bearing stubs one array level
 * down. Both drivers resolve through this, so a parent is never skipped in one
 * path while a contract test exercises another.
 */
export function resolveFanOutIds(
  param: string,
  parentRecord: unknown,
  parentTable: XeroSpecTable | null,
): readonly string[] {
  if (!param || parentRecord === null || typeof parentRecord !== "object") return [];
  const record = parentRecord as JsonRecord;
  const text = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    const out = String(value).trim();
    return out.length > 0 ? out : null;
  };

  const direct = text(record[param]);
  if (direct) return [direct];

  const viaRecordId = parentTable?.recordIdField ? text(record[parentTable.recordIdField]) : null;
  if (viaRecordId && parentTable?.recordIdField === param) return [viaRecordId];

  const stubs: string[] = [];
  for (const value of Object.values(record)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry === null || typeof entry !== "object") continue;
      const id = text((entry as JsonRecord)[param]);
      if (id) stubs.push(id);
    }
  }
  if (stubs.length > 0) return [...new Set(stubs)];

  return viaRecordId ? [viaRecordId] : [];
}

/**
 * Fill a sub-resource path from the ancestor records that produced it.
 *
 * `/Employees/{EmployeeID}/Working-Patterns/{EmployeeWorkingPatternID}` needs
 * the employee from one level and the pattern from the next, so each parameter
 * is taken from the nearest ancestor that actually carries it. Any parameter
 * left unfilled means the request cannot be issued — reported, never guessed.
 */
export function fillFanOutPath(
  template: string,
  ancestors: readonly unknown[],
): Readonly<{ path: string; missing: readonly string[] }> {
  const missing: string[] = [];
  const path = template.replace(/\{([^}]+)\}/gu, (_match, param: string) => {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
      const record = ancestors[index];
      if (record === null || record === undefined || typeof record !== "object") continue;
      const value = (record as JsonRecord)[param];
      if (value !== null && value !== undefined && String(value).trim().length > 0) {
        return encodeURIComponent(String(value));
      }
    }
    missing.push(param);
    return `{${param}}`;
  });
  return { path, missing };
}

/**
 * The chain of walks that must run before a fan-out can be issued: the scan
 * group walk first, then each intermediate fan-out. Working weeks hang off a
 * working pattern, which hangs off an employee — three requests deep, and any
 * link treated as optional means the leaf table stays empty.
 */
export function fanOutAncestry(fanOut: XeroFanOutScan): readonly XeroSpecTable[] {
  const chain: XeroSpecTable[] = [];
  let current: XeroSpecTable | undefined = fanOut.table;
  const byId = new Map(
    [
      ...XERO_SCAN_PLAN.groups.flatMap((group) => group.members.map((member) => member.table)),
      ...XERO_SCAN_PLAN.fanOuts.map((entry) => entry.table),
      ...XERO_SCAN_PLAN.fanOuts.flatMap((entry) => entry.members.map((member) => member.table)),
    ].map((table) => [table.id, table]),
  );
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    const parentId: string | null = current.source.parentTable;
    if (!parentId) break;
    const parent: XeroSpecTable | undefined = byId.get(parentId);
    if (!parent) break;
    current = parent;
    if (!parent.source.fanOutParam) {
      chain.unshift(parent);
      break;
    }
  }
  return chain;
}

/** The spec-derived parent set for a templated cross-parent fan-out, or null. */
export function templatedParents(fanOut: XeroFanOutScan): readonly XeroTemplatedParent[] | null {
  if (!fanOut.endpointOp.includes("{Endpoint}")) return null;
  if (/\/Attachments$/u.test(fanOut.endpointOp)) return XERO_ATTACHMENT_PARENTS;
  if (/\/History$/u.test(fanOut.endpointOp)) return XERO_HISTORY_PARENTS;
  return null;
}

/* ------------------------------------------------------------------ */
/* Stream helpers used by the connector                                */
/* ------------------------------------------------------------------ */

export function specTableFor(stream: XeroStream): XeroSpecTable {
  const viaGroup = XERO_SCAN_PLAN.groups
    .flatMap((group) => group.members)
    .find((member) => member.table.id === stream.id)?.table;
  const viaFanOut = XERO_SCAN_PLAN.fanOuts.find((fanOut) => fanOut.table.id === stream.id)?.table;
  const viaFanOutMember = XERO_SCAN_PLAN.fanOuts
    .flatMap((fanOut) => fanOut.members)
    .find((member) => member.table.id === stream.id)?.table;
  const table = viaGroup ?? viaFanOut ?? viaFanOutMember;
  if (!table) throw new Error(`Stream ${stream.id} has no spec table.`);
  return table;
}

/** The fan-out whose sub-responses carry this table's rows (walk or member). */
export function fanOutCarrying(table: XeroSpecTable): XeroFanOutScan | null {
  return (
    XERO_SCAN_PLAN.fanOuts.find(
      (fanOut) =>
        fanOut.table.id === table.id ||
        fanOut.members.some((member) => member.table.id === table.id),
    ) ?? null
  );
}

export function scanGroupFor(table: XeroSpecTable): XeroScanGroup | null {
  return (
    XERO_SCAN_PLAN.groups.find((group) =>
      group.members.some((member) => member.table.id === table.id),
    ) ?? null
  );
}

export function fanOutFor(table: XeroSpecTable): XeroFanOutScan | null {
  return XERO_SCAN_PLAN.fanOuts.find((fanOut) => fanOut.table.id === table.id) ?? null;
}
