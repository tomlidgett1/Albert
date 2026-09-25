/**
 * Lightspeed R-Series scan planner.
 *
 * Turns the 93-table spec into executable work. The central idea is the scan
 * group: tables that arrive from the same walk are fetched ONCE with the union
 * of their relations, and every member projects its rows out of the same
 * payload. One `Customer.json` walk fills ten tables; treating them as ten
 * streams would issue ten walks of the same data.
 *
 * Sharding is by immutable primary id, never by timestamp. `timeStamp` on
 * R-Series is a last-modified field, so a record can move between time windows
 * mid-walk and be missed by both. Ids do not move, which makes an id window a
 * unit of work that is resumable, idempotent, and — critically — provable:
 * for a closed window you know exactly which ids should have been considered.
 */
import tablesJson from "./tables.json" with { type: "json" };

export type SpecColumn = Readonly<{
  name: string;
  type: string;
  api: string;
  description: string;
  key: boolean;
  pii: boolean;
  loadBearing: boolean;
  deprecated: boolean;
  enums: string | null;
}>;

export type SpecTable = Readonly<{
  id: string;
  domain: string;
  grain: string;
  description: string;
  additivity: string;
  additivityAxis: string | null;
  primaryKey: readonly string[];
  recordIdField: string | null;
  endpoint: string | null;
  parents: readonly Readonly<{ resource: string; projectFrom: string | null }>[];
  scanGroups: readonly string[];
  isGroupLeader: boolean;
  requiresParentIds: boolean;
  viaAlias: string | null;
  loadRelations: readonly string[];
  pushdowns: readonly Readonly<{ column: string; param: string; sortable: boolean }>[];
  canonicalTargets: readonly string[];
  gotchas: readonly string[];
  columns: readonly SpecColumn[];
}>;

export const SPEC_TABLES: readonly SpecTable[] = (tablesJson as { tables: SpecTable[] }).tables;

/** A table's rows, and how they are obtained from the group's payload. */
export type GroupMember = Readonly<{
  table: SpecTable;
  /**
   * `records` — one row per fetched record, projected 1:1. The leader is always
   * this, and so are sibling reference tables that share its grain.
   * `nested`  — one row per element of the array at `projectFrom`.
   */
  projection: "records" | "nested";
  /** Dot path to the nested array; null when projection is `records`. */
  projectFrom: string | null;
}>;

export type ScanGroup = Readonly<{
  /** The R-Series resource walked, e.g. "Sale". */
  resource: string;
  /** `Sale.json` — the path actually requested. */
  path: string;
  /** The table whose grain equals one record of this resource. */
  leader: SpecTable;
  /** Every table filled by this walk, leader first. */
  members: readonly GroupMember[];
  /**
   * Union of the relations every member needs, deduplicated and with redundant
   * prefixes dropped: requesting both `SaleLines` and `SaleLines.Discount` is
   * wasteful because the latter implies the former.
   */
  relations: readonly string[];
  /** Vendor id field used for keyset sharding, e.g. "saleID". */
  idField: string;
  /** True when the vendor reliably filters and sorts on the id field. */
  keysetCapable: boolean;
  /** Populations hidden behind an explicit parameter, e.g. archived records. */
  extraParamSets: readonly Readonly<Record<string, string>>[];
}>;

/** Tables that must be fetched once per parent record, with no account-wide alias. */
export type FanOutScan = Readonly<{
  table: SpecTable;
  parentResource: string;
  endpoint: string;
}>;

export type ScanPlan = Readonly<{
  groups: readonly ScanGroup[];
  fanOuts: readonly FanOutScan[];
  /** Every table appears exactly once across groups+fanOuts; asserted at build time. */
  tableCount: number;
}>;

/**
 * Populations R-Series hides unless explicitly asked for. Verified against the
 * documented `archived` parameter (false | true | only) and the CreditAccount
 * gift-card flag. `Sale` is deliberately absent: its archived filter is
 * documented but observed to be ignored, so a second pass would spend a full
 * duplicate history walk for zero new rows. That is recorded as a known gap by
 * the completeness auditor rather than papered over with a wasted scan.
 */
const EXTRA_PARAM_SETS: Readonly<Record<string, readonly Readonly<Record<string, string>>[]>> = {
  Item: [{ archived: "only" }],
  Customer: [{ archived: "only" }],
  Employee: [{ archived: "only" }],
  Vendor: [{ archived: "only" }],
  ItemMatrix: [{ archived: "only" }],
  Discount: [{ archived: "only" }],
  CreditAccount: [{ giftCard: "true" }],
};

/**
 * Drop a relation that a longer path already implies. Requesting
 * `SaleLines.Discount` necessarily loads `SaleLines`, so sending both wastes
 * payload and brings the request closer to the documented memory-exhaustion 500.
 */
export function collapseRelations(relations: readonly string[]): readonly string[] {
  const unique = [...new Set(relations.filter((r) => r.trim().length > 0))].sort();
  return unique.filter(
    (r) => !unique.some((other) => other !== r && other.startsWith(`${r}.`)),
  );
}

/** Resource path as requested from the API. */
export function resourcePath(resource: string): string {
  return `${resource}.json`;
}

function idFieldFor(resource: string, members: readonly GroupMember[]): string {
  const leader = members[0]?.table;
  if (leader?.recordIdField) return leader.recordIdField;
  // Fall back to the conventional R-Series pattern: <resource><ID>.
  return `${resource.charAt(0).toLowerCase()}${resource.slice(1)}ID`;
}

/**
 * Keyset sharding needs the vendor to both filter and sort on the id field.
 * The spec records which columns carry a pushdown parameter and which are
 * sortable; absent evidence we do not assume it works.
 */
function keysetCapable(members: readonly GroupMember[], idField: string): boolean {
  const leader = members[0]?.table;
  if (!leader) return false;
  const idColumn = leader.columns.find((c) => c.api.split(".").pop() === idField);
  if (!idColumn) return false;
  return leader.pushdowns.some((p) => p.column === idColumn.name);
}

export function buildScanPlan(tables: readonly SpecTable[] = SPEC_TABLES): ScanPlan {
  const byGroup = new Map<string, { leader?: SpecTable; members: GroupMember[] }>();
  const fanOuts: FanOutScan[] = [];

  for (const table of tables) {
    if (table.requiresParentIds) {
      fanOuts.push({
        table,
        parentResource: table.scanGroups[0] ?? "",
        endpoint: table.endpoint ?? "",
      });
      continue;
    }
    for (const parent of table.parents) {
      let entry = byGroup.get(parent.resource);
      if (!entry) {
        entry = { members: [] };
        byGroup.set(parent.resource, entry);
      }
      // Several tables may share a resource's grain (a transfer's origin and
      // destination are both one row per transfer). Exactly one is the leader:
      // the one whose record id field matches the resource's own id.
      const conventionalId = `${parent.resource.charAt(0).toLowerCase()}${parent.resource.slice(1)}ID`;
      if (table.isGroupLeader && (!entry.leader || table.recordIdField === conventionalId)) {
        entry.leader = table;
      }
      // A few spec entries annotate the path in prose ("EmployeeRole (single
      // nested object per employee; …)"). Only the dot path is executable:
      // the annotation would otherwise ride into `load_relations` and make
      // `resolvePath` look for a key that can never exist.
      const projectFrom = parent.projectFrom
        ? parent.projectFrom.replace(/\s*\(.*$/u, "").trim() || null
        : null;
      entry.members.push({
        table,
        projection: projectFrom ? "nested" : "records",
        projectFrom,
      });
    }
  }

  const groups: ScanGroup[] = [];
  for (const [resource, entry] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
    const leader = entry.leader;
    if (!leader) {
      throw new Error(
        `Scan group ${resource} has no leader table. A group must contain exactly one table ` +
          `whose grain equals one record of the resource, or its members can never be fetched.`,
      );
    }
    // Leader first: members project out of the records it yields.
    const members = [
      ...entry.members.filter((m) => m.table.id === leader.id),
      ...entry.members.filter((m) => m.table.id !== leader.id),
    ];
    const relations = collapseRelations(members.flatMap((m) => m.table.loadRelations));
    const idField = idFieldFor(resource, members);

    groups.push({
      resource,
      path: resourcePath(resource),
      leader,
      members,
      relations,
      idField,
      keysetCapable: keysetCapable(members, idField),
      extraParamSets: EXTRA_PARAM_SETS[resource] ?? [],
    });
  }

  const covered = new Set<string>([
    ...groups.flatMap((g) => g.members.map((m) => m.table.id)),
    ...fanOuts.map((f) => f.table.id),
  ]);
  const missing = tables.filter((t) => !covered.has(t.id)).map((t) => t.id);
  if (missing.length > 0) {
    throw new Error(
      `Scan plan does not cover every table. Unreachable: ${missing.join(", ")}. ` +
        `An unreachable table can never be populated, so this is a build-time failure.`,
    );
  }

  return { groups, fanOuts, tableCount: covered.size };
}

/**
 * Split an id range into windows. A window is a unit of work: resumable on
 * crash, idempotent on retry, and individually verifiable because its expected
 * id set is known before the walk starts.
 */
export function shardIdRange(
  minId: number,
  maxId: number,
  idsPerShard: number,
): readonly Readonly<{ from: number; to: number }>[] {
  if (!Number.isFinite(minId) || !Number.isFinite(maxId) || maxId < minId) return [];
  if (!Number.isInteger(idsPerShard) || idsPerShard < 1) {
    throw new Error("idsPerShard must be a positive integer.");
  }
  const shards: { from: number; to: number }[] = [];
  for (let from = minId; from <= maxId; from += idsPerShard) {
    shards.push({ from, to: Math.min(from + idsPerShard - 1, maxId) });
  }
  return shards;
}

/**
 * Requests needed to cover an id range, given how densely ids are populated.
 * Sparse id spaces (heavily deleted resources) cost pages, not ids, so shard
 * size is chosen against observed density rather than raw range width.
 */
export function estimateRequests(
  recordCount: number,
  pageSize = 100,
): number {
  if (recordCount <= 0) return 1;
  return Math.ceil(recordCount / pageSize);
}
