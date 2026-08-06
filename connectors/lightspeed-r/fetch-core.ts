/**
 * Lightspeed R-Series fetch core.
 *
 * Executes one scan group: a single walk of a resource that yields rows for
 * every table in the group. Three properties matter more than speed:
 *
 *   COMPLETENESS  Windows are bounded by immutable primary id, so for any
 *                 window the set of ids that should have been considered is
 *                 known before the walk starts. That turns "did we get
 *                 everything" from a hope into an assertion.
 *   RESUMABILITY  Progress is committed per page. A crash re-runs one window,
 *                 not the whole resource.
 *   HONESTY       A page that cannot safely advance returns a structured
 *                 pagination block instead of throwing, so the malformed rows
 *                 are retained as evidence and the cursor is NOT committed.
 *
 * Relation loading is the difference between 63 walks and thousands, but it
 * fails silently: if a relations request 500s and the caller quietly retries
 * without them, the walk succeeds and every child table comes back empty. Every
 * page is therefore asserted against the relations that were requested.
 */
import { ConnectorError } from "../../packages/connector-sdk/src/errors.js";
import type { RawSourceRecord, SyncPage } from "../../packages/connector-sdk/src/index.js";
import type { GroupMember, ScanGroup } from "./scan-plan.js";

/** R-Series caps page size at 100. */
export const MAX_PAGE_SIZE = 100;

export type IdWindow = Readonly<{ from: number; to: number }>;

export type FetchRequest = Readonly<{
  path: string;
  params: Readonly<Record<string, string>>;
}>;

/** One page as returned by the vendor, already parsed. */
export type VendorPage = Readonly<{
  records: readonly Readonly<Record<string, unknown>>[];
  /** `@attributes.next`, absent on the terminal page. */
  nextUrl: string | null;
  /** `@attributes.count` when the vendor reports it. */
  reportedCount: number | null;
}>;

export type PageOutcome =
  | Readonly<{ kind: "page"; records: readonly RawSourceRecord[]; nextUrl: string | null }>
  | Readonly<{ kind: "blocked"; block: NonNullable<SyncPage["paginationBlock"]>; records: readonly RawSourceRecord[] }>;

/**
 * Build the request for one page of a scan group.
 *
 * `after` is the vendor's opaque continuation. It is deliberately mutually
 * exclusive with the id filter and sort: R-Series bakes both into the token, and
 * re-sending them alongside a continuation is how walks silently restart.
 */
export function buildPageRequest(
  group: ScanGroup,
  options: Readonly<{
    window?: IdWindow;
    after?: string | null;
    extraParams?: Readonly<Record<string, string>>;
    pageSize?: number;
  }> = {},
): FetchRequest {
  const params: Record<string, string> = {};
  const pageSize = Math.min(options.pageSize ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);

  if (options.after) {
    params.after = options.after;
  } else {
    params.limit = String(pageSize);
    // Ascending primary id is the only stable order: records inserted mid-walk
    // take higher ids and land at the end, so they are never skipped.
    params.sort = group.idField;
    if (options.window && group.keysetCapable) {
      params[group.idField] = `><,${options.window.from},${options.window.to}`;
    }
  }

  if (group.relations.length > 0) {
    params.load_relations = JSON.stringify(group.relations);
  }
  for (const [key, value] of Object.entries(options.extraParams ?? {})) {
    params[key] = value;
  }
  return { path: group.path, params };
}

/** The single-row probe used to discover an id bound for one unit, not ten. */
export function buildBoundRequest(
  group: ScanGroup,
  bound: "min" | "max",
  extraParams: Readonly<Record<string, string>> = {},
): FetchRequest {
  return {
    path: group.path,
    params: {
      limit: "1",
      sort: bound === "max" ? `-${group.idField}` : group.idField,
      ...extraParams,
    },
  };
}

/**
 * Parse an R-Series envelope. The records live under a key named for the
 * resource, and a single result is returned as an object rather than an array.
 */
export function parseEnvelope(body: unknown, resource: string): VendorPage {
  if (body === null || typeof body !== "object") {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", "Vendor response was not a JSON object.");
  }
  const envelope = body as Record<string, unknown>;
  const attributes = (envelope["@attributes"] ?? {}) as Record<string, unknown>;

  const raw = envelope[resource];
  const records =
    raw === undefined || raw === null
      ? []
      : Array.isArray(raw)
        ? (raw as Record<string, unknown>[])
        : [raw as Record<string, unknown>];

  const nextRaw = attributes.next;
  const nextUrl = typeof nextRaw === "string" && nextRaw.length > 0 ? nextRaw : null;
  const countRaw = attributes.count;
  const reportedCount =
    countRaw === undefined ? null : Number.isFinite(Number(countRaw)) ? Number(countRaw) : null;

  return { records, nextUrl, reportedCount };
}

/** Extract the opaque `after` token from the vendor's next URL. */
export function afterTokenFrom(nextUrl: string | null): string | null {
  if (!nextUrl) return null;
  try {
    return new URL(nextUrl).searchParams.get("after");
  } catch {
    // Relative or malformed: fall back to a direct read of the query string.
    const match = nextUrl.match(/[?&]after=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }
}

/** Resolve a dot path inside a record, tolerating R-Series' singular wrappers. */
export function resolvePath(record: unknown, path: string): unknown[] {
  let current: unknown = record;
  for (const segment of path.split(".").filter(Boolean)) {
    if (current === null || typeof current !== "object") return [];
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return [];
  }
  if (current === null || current === undefined) return [];
  return Array.isArray(current) ? current : [current];
}

/**
 * Relations the vendor legitimately omits from every record of a page when no
 * related entity exists, observed live rather than assumed. CreditAccount:
 * this account's credit accounts are all gift cards, and a bare `Contact`
 * request (no nested paths, so no silent-drop ambiguity) still returned no
 * Contact key on any record — gift cards simply have no contact person. A
 * sparse member stages zero rows from that parent, which is the true state.
 */
const SPARSE_RELATIONS: ReadonlySet<string> = new Set(["CreditAccount.Contact"]);

/**
 * Assert that every requested relation actually came back. Without this a
 * silent fallback to a relation-free request produces a successful walk and
 * empty child tables, which is far worse than a loud failure.
 */
export function assertRelationsPresent(
  group: ScanGroup,
  records: readonly Readonly<Record<string, unknown>>[],
): void {
  if (records.length === 0) return;

  // The assertion set is NOT the relation union. Most requested relations belong
  // to a child level (`Item` and `TaxClass` hang off a SaleLine, not off a Sale)
  // and will never appear on the parent record. What matters is the first
  // segment of each nested member's projection path: if that key is missing from
  // every record, that member's table silently stages zero rows.
  const required = [
    ...new Set(
      group.members
        .filter((m) => m.projection === "nested" && m.projectFrom)
        .map((m) => m.projectFrom!.split(".")[0])
        .filter((root) => !SPARSE_RELATIONS.has(`${group.resource}.${root}`)),
    ),
  ];
  if (required.length === 0) return;

  const missing = required.filter((key) => !records.some((record) => key in record));
  if (missing.length > 0) {
    const affected = group.members
      .filter((m) => m.projection === "nested" && m.projectFrom && missing.includes(m.projectFrom.split(".")[0]))
      .map((m) => m.table.id);
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      `Relations absent from every record of ${group.resource}: ${missing.join(", ")}. ` +
        `${affected.join(", ")} would stage zero rows, so the page is rejected rather than committed.`,
      {
        details: {
          resource: group.resource,
          missing: missing.join(","),
          affected: affected.join(","),
          requested: group.relations.join(","),
        },
      },
    );
  }
}

const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  ) ?? "null";

export type HashFn = (input: string) => string;

/** Read a record's vendor id, tolerating string ids. */
export function readRecordId(record: Record<string, unknown>, idField: string): string | null {
  const value = record[idField];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/**
 * Project one fetched page into staging records for every table in the group.
 * The leader yields one record per fetched record; nested members yield one per
 * element of their array. Each carries the object type of its own table so the
 * worker routes it to the right staging table.
 */
export function projectPage(
  group: ScanGroup,
  page: VendorPage,
  hash: HashFn,
): readonly RawSourceRecord[] {
  const out: RawSourceRecord[] = [];

  for (const record of page.records) {
    for (const member of group.members) {
      if (member.projection === "records") {
        emit(out, group, member, record, record, hash);
        continue;
      }
      const path = member.projectFrom;
      if (!path) continue;
      for (const child of resolvePath(record, path)) {
        if (child === null || typeof child !== "object") continue;
        emit(out, group, member, child as Record<string, unknown>, record, hash);
      }
    }
  }
  return out;
}

function emit(
  out: RawSourceRecord[],
  group: ScanGroup,
  member: GroupMember,
  payload: Record<string, unknown>,
  parent: Record<string, unknown>,
  hash: HashFn,
): void {
  const idField = member.table.recordIdField;
  const own = idField ? readRecordId(payload, idField) : null;
  // A child whose uid is unique only within its parent is keyed on both, and a
  // table with no id at all (a computed aggregate) is keyed on its parent plus
  // ordinal so re-running a window is still idempotent.
  const parentId = readRecordId(parent, group.idField);
  const sourceRecordId =
    own ?? (parentId ? `${parentId}:${out.length}` : `${group.resource}:${out.length}`);

  out.push({
    sourceObjectType: member.table.id,
    sourceRecordId,
    ...(readSourceUpdatedAt(payload) ? { sourceUpdatedAt: readSourceUpdatedAt(payload)! } : {}),
    payload,
    payloadHash: hash(stableStringify(payload)),
  });
}

/** R-Series exposes last-modified as `timeStamp` on most resources. */
export function readSourceUpdatedAt(record: Record<string, unknown>): string | null {
  for (const key of ["timeStamp", "updateTime", "createTime"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

/**
 * Decide whether a page may commit its cursor. A vendor that returns a
 * non-terminal page whose continuation does not move would otherwise loop
 * forever; that is reported as structured evidence rather than thrown.
 */
export function evaluatePagination(
  previousAfter: string | null,
  nextUrl: string | null,
  recordCount: number,
): Readonly<{ nextAfter: string | null; block: NonNullable<SyncPage["paginationBlock"]> | null }> {
  const nextAfter = afterTokenFrom(nextUrl);

  if (nextUrl && !nextAfter) {
    return {
      nextAfter: null,
      block: {
        code: "pagination_identity_invalid",
        detail: "The vendor advertised a next page but its continuation token could not be read.",
      },
    };
  }
  if (nextAfter && nextAfter === previousAfter) {
    return {
      nextAfter: null,
      block: {
        code: "pagination_not_advancing",
        detail: `The continuation token repeated after ${recordCount} records; advancing would loop.`,
      },
    };
  }
  return { nextAfter, block: null };
}
