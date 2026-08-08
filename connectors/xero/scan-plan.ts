/**
 * Xero scan planner.
 *
 * Turns the spec (tables.json, generated from the official Xero OpenAPI at the
 * pinned revision) into executable work. The central idea is the scan group:
 * tables filled by the same endpoint walk are declared together — one
 * `GET /Invoices` walk yields invoices, their line items, their line-item
 * tracking and their addresses, each projected from the same payload.
 *
 * Xero paginates by page number with a fixed `order=` clause rather than by
 * keyset, so completeness rests on the ordered two-pass digest the connector
 * already implements plus fixed `where` upper bounds that stop a record from
 * moving between pages mid-walk. Fan-out endpoints (attachments, history,
 * online invoices, contact CIS settings) are parent-scoped: one request per
 * parent id, budget-priced, and therefore declared optional.
 */
import tablesJson from "./tables.json" with { type: "json" };

export type XeroSpecColumn = Readonly<{
  name: string;
  type: string;
  api: string;
  description: string;
  key: boolean;
  pii: boolean;
  loadBearing: boolean;
  deprecated: boolean;
  enums: string | null;
  coversNested: readonly string[];
}>;

export type XeroSpecSource = Readonly<{
  /** Which official spec the table comes from. */
  api:
    | "accounting"
    | "assets"
    | "projects"
    | "files"
    | "payroll_au"
    | "payroll_uk"
    | "payroll_nz"
    | "identity";
  /** The exact read operation, e.g. `GET /Invoices`. */
  endpointOp: string;
  /** Response envelope schema name, e.g. `Invoices`. */
  envelope: string | null;
  /** Property inside the envelope holding the records; null when the response is the record. */
  arrayKey: string | null;
  /** Dot path when rows explode from a parent's nested array, e.g. `Invoice.LineItems`. */
  explodePath: string | null;
  /**
   * Object name at every level the explode path traverses, walked record first
   * and the projected element last (`["Budget","BudgetLine","BudgetBalance"]`).
   * Precomputed from the specification's schema graph so projection can resolve
   * a citation rooted at any enclosing level — a budget balance legitimately
   * carries its line's AccountID — without shipping the graph to runtime.
   */
  explodeChain?: readonly string[];
  /** The spec table rows explode from or fan out of. */
  parentTable: string | null;
  /** Path parameter carrying the parent id for fan-out endpoints, e.g. `InvoiceID`. */
  fanOutParam: string | null;
  pagination: "page" | "offset" | "none" | "parent";
  /** Vendor modified-watermark field, e.g. `UpdatedDateUTC`. */
  modifiedField: string | null;
  whereFilterable: boolean;
  scopes: readonly string[];
  availability: "required" | "optional";
}>;

export type XeroSpecTable = Readonly<{
  id: string;
  domain: string;
  grain: string;
  description: string;
  additivity: string;
  additivityAxis: string | null;
  primaryKey: readonly string[];
  recordIdField: string | null;
  source: XeroSpecSource;
  sourceObjects: readonly string[];
  canonicalTargets: readonly string[];
  gotchas: readonly string[];
  columns: readonly XeroSpecColumn[];
}>;

export const XERO_SPEC_TABLES: readonly XeroSpecTable[] = (
  tablesJson as { tables: XeroSpecTable[] }
).tables;

export const XERO_SPEC_REVISION: string = (tablesJson as { generatedFrom: string }).generatedFrom;

/**
 * The staged field name for a column: the provenance path relative to the
 * owning object. `accounting:Payment.Amount` stages as `Amount`;
 * `accounting:Payment.BatchPayment.Date` stages as `BatchPayment_Date` so two
 * flattened paths sharing a leaf can never collide; synthetic columns stage
 * under their own name. `stagingColumnName(...)` snake_cases the result, which
 * is exactly the spec column name — asserted at build time so the dictionary,
 * the staging DDL and the projection can never drift apart.
 */
/**
 * Columns every staging table already has. A vendor field that snake_cases onto
 * one of these cannot be staged under its own name — Xero's own `tenantId` on a
 * connection is a different thing from Albert's tenant — so it is qualified with
 * its object instead of silently colliding.
 */
const RESERVED_STAGING_COLUMNS: ReadonlySet<string> = new Set([
  "tenant_id", "namespaced_source_key", "connection_id", "external_account_reference",
  "source_object_type", "source_record_id", "source_version", "source_updated_at",
  "payload_hash", "payload_batch_id", "sync_run_id", "tombstone", "mapping_version",
  "first_ingested_at", "ingested_at",
]);

function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

export function xeroSourceField(column: XeroSpecColumn): string {
  const api = column.api;
  if (api.startsWith("synthetic:")) return column.name;
  const path = api.slice(api.indexOf(":") + 1).replace(/\[\]( index)?$/, "").split(".");
  const segments = path.slice(1);
  if (segments.length === 0) return column.name;
  const base = segments.length === 1 ? segments[0]! : segments.join("_");
  return RESERVED_STAGING_COLUMNS.has(snakeCase(base)) ? `${path[0]}_${base}` : base;
}

/** A table's rows, and how they are obtained from the group's walk. */
export type XeroGroupMember = Readonly<{
  table: XeroSpecTable;
  projection: "records" | "nested";
  /** Dot path to the nested array, relative to the walked record; null for `records`. */
  projectFrom: string | null;
}>;

export type XeroScanGroup = Readonly<{
  /** The spec the walk belongs to — `GET /Settings` exists in several APIs. */
  api: XeroSpecSource["api"];
  /** The endpoint walked, e.g. `GET /Invoices`. */
  endpointOp: string;
  /** Vendor resource name (the envelope's array key), e.g. `Invoices`. */
  resource: string;
  leader: XeroSpecTable;
  members: readonly XeroGroupMember[];
  pagination: "page" | "offset" | "none";
  modifiedField: string | null;
  whereFilterable: boolean;
  scopes: readonly string[];
}>;

/** Parent-scoped endpoints fetched once per parent id. */
export type XeroFanOutScan = Readonly<{
  table: XeroSpecTable;
  parentTable: string;
  endpointOp: string;
  fanOutParam: string;
  /**
   * Tables exploded from this fan-out's sub-responses (AU payslip line
   * families project from each `GET /Payslip/{PayslipID}` payload).
   */
  members: readonly XeroGroupMember[];
}>;

export type XeroScanPlan = Readonly<{
  groups: readonly XeroScanGroup[];
  fanOuts: readonly XeroFanOutScan[];
  tableCount: number;
}>;

export function buildXeroScanPlan(
  tables: readonly XeroSpecTable[] = XERO_SPEC_TABLES,
): XeroScanPlan {
  const byId = new Map(tables.map((table) => [table.id, table]));
  const byOp = new Map<string, { leader?: XeroSpecTable; members: XeroGroupMember[] }>();
  const fanOutEntries: { table: XeroSpecTable; members: XeroGroupMember[] }[] = [];

  // First pass: elect one walk per fan-out endpoint. Several tables can be fed
  // by the same sub-request — `GET /Budgets/{BudgetID}` yields both budget
  // lines and, one level deeper, their balances — so the outermost table (the
  // shortest explode path, or none at all) issues the request and the rest
  // project from the same payload. A templated cross-parent fan-out
  // (`GET /{Endpoint}/{Guid}/Attachments`) iterates a spec-derived parent set
  // instead of one parent table.
  const fanOutCandidates = new Map<string, XeroSpecTable[]>();
  for (const table of tables) {
    if (!table.source.fanOutParam) continue;
    const templated = table.source.endpointOp.includes("{Endpoint}");
    if (!templated && (!table.source.parentTable || !byId.has(table.source.parentTable))) {
      throw new Error(
        `Fan-out table ${table.id} names parent ${table.source.parentTable ?? "<none>"}, which is not a spec table.`,
      );
    }
    const key = `${table.source.api} ${table.source.endpointOp}`;
    const bucket = fanOutCandidates.get(key) ?? [];
    bucket.push(table);
    fanOutCandidates.set(key, bucket);
  }
  for (const [, candidates] of fanOutCandidates) {
    const ordered = [...candidates].sort((left, right) =>
      (left.source.explodePath ?? "").length - (right.source.explodePath ?? "").length ||
      left.id.localeCompare(right.id));
    const [walk, ...rest] = ordered;
    const members: XeroGroupMember[] = rest.map((table) => ({
      table,
      projection: "nested" as const,
      projectFrom: table.source.explodePath ? stripRoot(table.source.explodePath) : null,
    }));
    fanOutEntries.push({ table: walk!, members });
  }
  // `GET /Settings` and `GET /Employees` exist in several APIs, and AU
  // `GET /PayItems` carries four sibling arrays that are each their own scan,
  // so every walk is keyed by spec + operation + projected array.
  const walkKey = (source: XeroSpecSource) => `${source.api} ${source.endpointOp} ${source.arrayKey ?? ""}`;
  // Fan-out sub-requests are keyed by spec + operation only: one sub-request
  // serves every table projected from its payload, whatever each one names as
  // its array.
  const fanOutByOp = new Map(
    fanOutEntries.map((entry) => [`${entry.table.source.api} ${entry.table.source.endpointOp}`, entry]),
  );

  for (const table of tables) {
    const source = table.source;
    if (source.fanOutParam) continue; // fan-out walk or member, handled above
    const fanOutOpKey = `${source.api} ${source.endpointOp}`;
    if (source.explodePath && fanOutByOp.has(fanOutOpKey)) {
      // Nested rows inside a fan-out's sub-response.
      fanOutByOp.get(fanOutOpKey)!.members.push({
        table,
        projection: "nested",
        projectFrom: stripRoot(source.explodePath),
      });
      continue;
    }
    let entry = byOp.get(walkKey(source));
    if (!entry) {
      entry = { members: [] };
      byOp.set(walkKey(source), entry);
    }
    if (source.explodePath) {
      entry.members.push({ table, projection: "nested", projectFrom: stripRoot(source.explodePath) });
    } else {
      if (entry.leader) {
        throw new Error(
          `Scan group ${source.endpointOp} declares two leaders: ${entry.leader.id} and ${table.id}. ` +
            `Exactly one table per walk may project records 1:1.`,
        );
      }
      entry.leader = table;
      entry.members.unshift({ table, projection: "records", projectFrom: null });
    }
  }

  const fanOuts: XeroFanOutScan[] = fanOutEntries.map((entry) => ({
    table: entry.table,
    parentTable: entry.table.source.parentTable ?? "",
    endpointOp: entry.table.source.endpointOp,
    fanOutParam: entry.table.source.fanOutParam!,
    members: entry.members,
  }));

  const groups: XeroScanGroup[] = [];
  for (const [key, entry] of [...byOp].sort(([a], [b]) => a.localeCompare(b))) {
    const leader = entry.leader;
    if (!leader) {
      throw new Error(
        `Scan group ${key} has no leader table; its nested members could never be fetched.`,
      );
    }
    if (leader.source.pagination === "parent") {
      throw new Error(`Leader ${leader.id} of ${key} cannot use pagination "parent".`);
    }
    groups.push({
      api: leader.source.api,
      endpointOp: leader.source.endpointOp,
      resource: leader.source.arrayKey ?? leader.source.envelope ?? leaderResource(leader.source.endpointOp),
      leader,
      members: entry.members,
      pagination: leader.source.pagination,
      modifiedField: leader.source.modifiedField,
      whereFilterable: leader.source.whereFilterable,
      scopes: leader.source.scopes,
    });
  }

  const covered = new Set<string>([
    ...groups.flatMap((group) => group.members.map((member) => member.table.id)),
    ...fanOuts.map((fanOut) => fanOut.table.id),
    ...fanOuts.flatMap((fanOut) => fanOut.members.map((member) => member.table.id)),
  ]);
  const missing = tables.filter((table) => !covered.has(table.id)).map((table) => table.id);
  if (missing.length > 0) {
    throw new Error(
      `Scan plan does not cover every table. Unreachable: ${missing.join(", ")}. ` +
        `An unreachable table can never be populated, so this is a build-time failure.`,
    );
  }

  // Every fan-out's parent must itself be reachable, or the fan-out never
  // runs. Templated cross-parent fan-outs carry no single parent table — their
  // parent set is spec-derived in spec-sync.
  for (const fanOut of fanOuts) {
    if (fanOut.parentTable && !covered.has(fanOut.parentTable)) {
      throw new Error(`Fan-out ${fanOut.table.id} depends on unreachable parent ${fanOut.parentTable}.`);
    }
  }

  // Staged field names must be unique per table and equal the spec column name
  // once snake_cased, or projection and DDL would disagree about the schema.
  for (const table of tables) {
    const seen = new Set<string>();
    for (const column of table.columns) {
      const field = xeroSourceField(column);
      if (seen.has(field)) {
        throw new Error(`${table.id} stages two columns as ${field}; provenance paths must be unique.`);
      }
      seen.add(field);
    }
  }

  return { groups, fanOuts, tableCount: covered.size };
}

function stripRoot(explodePath: string): string {
  const segments = explodePath.split(".");
  return segments.length > 1 ? segments.slice(1).join(".") : explodePath;
}

function leaderResource(endpointOp: string): string {
  const path = endpointOp.split(" ")[1] ?? endpointOp;
  const last = path.split("/").filter(Boolean).pop() ?? path;
  return last;
}

export const XERO_SCAN_PLAN: XeroScanPlan = buildXeroScanPlan();
