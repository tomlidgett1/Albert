/**
 * Lightspeed R-Series stream contracts, derived from the table spec.
 *
 * `staging.ts` builds one table per stream, so the 90 spec tables become 90
 * stream contracts. They are generated rather than hand-written: a hand-kept
 * list drifts from the spec, and a drifted stream is a table that silently
 * stages nothing.
 *
 * Fetching is grouped, not per-stream. Members of a scan group are marked
 * `derivedFrom`, and the connector serves them from the leader's page cache so
 * one `Sale.json` walk fills every sale-derived table instead of six walks of
 * the same data.
 */
import type { StreamContract } from "../../packages/connector-sdk/src/contract.js";
import { SPEC_TABLES, buildScanPlan, type SpecTable } from "./scan-plan.js";

/**
 * Canonical targets for the streams whose mappers predate the spec. The mapper
 * is the authority on what it emits, and a stream that declares less than its
 * mapper produces is rejected at transform time as a target mismatch. The spec's
 * narrower list is a documentation view; these are the executable truth.
 */
const MAPPED_STREAM_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ls_shops: ["location", "stock_location", "identity_hint"],
  ls_registers: ["register"],
  ls_employees: ["person", "worker", "identity_hint"],
  ls_categories: ["product_category"],
  ls_items: ["product", "product_variant", "identity_hint", "category_assignment"],
  ls_item_shops: ["inventory_balance_snapshot"],
  // The sale walk is split: the header owns the order (plus the synthetic
  // in-store channel and a register stub for arrival-order robustness), lines
  // own order lines and refunds, payments own tenders. One economic event can
  // therefore never project twice.
  ls_sales: ["channel", "register", "commerce_order"],
  ls_sale_lines: ["commerce_order_line", "commerce_refund_line", "event_link"],
  ls_sale_payments: ["commerce_payment"],
  ls_customers: ["person", "customer_account", "identity_hint"],
  ls_vendors: ["supplier", "identity_hint"],
  ls_purchase_orders: ["metadata"],
  ls_purchase_order_lines: ["purchase_order_line"],
  ls_payment_types: ["metadata"],
  ls_tax_categories: ["tax_code"],
  ls_inventory_logs: ["inventory_movement"],
});

/**
 * Authority concept for the streams whose mappers predate the spec. Authority is
 * asserted per command at transform time, so a stream declaring a different
 * concept than its mapper writes under is rejected. These are the executable
 * values; the per-domain defaults below cover only the spec-added streams.
 */
const MAPPED_STREAM_AUTHORITY: Readonly<Record<string, string>> = Object.freeze({
  ls_shops: "operational_sales",
  ls_registers: "operational_sales",
  ls_employees: "operational_sales",
  ls_categories: "product_master",
  ls_items: "product_master",
  ls_item_shops: "stock",
  ls_sales: "operational_sales",
  ls_sale_lines: "operational_sales",
  ls_sale_payments: "operational_sales",
  ls_customers: "customer_master",
  ls_vendors: "stock",
  ls_purchase_orders: "stock",
  ls_purchase_order_lines: "stock",
  ls_payment_types: "operational_sales",
  ls_tax_categories: "operational_sales",
  ls_inventory_logs: "stock",
});

/** Product-facing readiness domain for each spec domain. */
const PRODUCT_DOMAIN: Readonly<Record<string, StreamContract["productDomains"][number]>> = {
  sales: "sales",
  catalogue: "products",
  inventory: "inventory",
  purchasing: "inventory",
  customers: "customers",
  workshop: "sales",
  org: "workforce",
  registers: "sales",
  taxreports: "accounting",
};

/** Governing source-authority concept for each spec domain. */
const AUTHORITY: Readonly<Record<string, StreamContract["authorityConcept"]>> = {
  sales: "operational_sales",
  catalogue: "product_master",
  inventory: "stock",
  purchasing: "stock",
  customers: "customer_master",
  workshop: "operational_sales",
  org: "operational_sales",
  registers: "cash_settlement",
  taxreports: "statutory_finance",
};

/**
 * A stream carrying a last-modified field can be swept for late edits by that
 * field. One that cannot must be re-snapshotted, because there is no way to ask
 * the vendor what changed.
 */
function lateEditStrategy(table: SpecTable): StreamContract["lateEditStrategy"] {
  const hasModified = table.columns.some((c) => /^(timeStamp|updateTime)$/.test(c.api.split(".").pop() ?? ""));
  if (hasModified) return "modified_field";
  return table.additivity === "reference" ? "full_snapshot" : "append_only";
}

/**
 * Only a source that can be enumerated authoritatively may retire an identity.
 * Anything else would let a transient absence delete real rows.
 */
function deletionStrategy(table: SpecTable): StreamContract["deletionStrategy"] {
  const hasArchived = table.columns.some((c) => c.name === "archived");
  if (hasArchived) return "soft_delete";
  // Immutability is earned twice over: additive grain AND no modified field.
  // An additive table the vendor stamps with edit times (a sale line) is
  // editable and deletable, so only an authoritative scan may retire its rows.
  if (table.additivity === "additive" && !modifiedField(table)) return "immutable_append_only";
  return "authoritative_identity_scan";
}

/**
 * Time-windowed backfill only makes sense where the vendor can filter by a time
 * field. Everything else is scanned once and must publish completion evidence.
 */
function backfillStrategy(table: SpecTable): StreamContract["backfillStrategy"] {
  const timeFilterable = table.pushdowns.some((p) => /time|timeStamp|Date/i.test(p.param));
  return timeFilterable ? "time_windowed" : "snapshot";
}

const modifiedField = (table: SpecTable): string | undefined => {
  const match = table.columns.find((c) => {
    const leaf = c.api.split(".").pop();
    return leaf === "timeStamp" || leaf === "updateTime";
  });
  return match?.name;
};

/**
 * The vendor field the transform reads a row's identity from. It must be a real
 * source-field name: the staged projection is keyed by source field, so a
 * snake_case column name or a prose provenance note is filtered out and then
 * read back as a missing id. A few spec entries document their provenance in
 * prose (a computed sub-resource has no field of its own), so the first column
 * whose provenance is a clean identifier wins.
 */
function resolveRecordIdField(table: SpecTable): string {
  const clean = (value: string | null | undefined): string | null => {
    const leaf = String(value ?? "").split(".").pop()?.trim() ?? "";
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(leaf) ? leaf : null;
  };
  const declared = clean(table.recordIdField);
  if (declared) return declared;
  for (const column of table.columns) {
    const candidate = clean(column.api);
    if (candidate) return candidate;
  }
  return clean(table.primaryKey[0]) ?? "id";
}

/**
 * The vendor object a column's field lives on: the segment immediately before
 * the leaf. The spec addresses some tables from the walk root
 * (Item.ItemShops.ItemShop.qoh) and others from the child itself
 * (SaleLine.saleLineID); the penultimate segment names the owner either way.
 */
export function apiOwner(api: string): string {
  const segments = api.split(".");
  return segments.length >= 2 ? (segments[segments.length - 2] as string) : (segments[0] ?? "");
}

/**
 * The vendor resource this table's rows belong to. Identity decides: the
 * owner of the record-id column names the resource the row IS, no matter how
 * many parent-context columns (Sale.completed on a sale line, Item.* on an
 * item shop) ride along. Tables whose id is documented in prose fall back to
 * the majority owner across columns.
 */
export function ownResource(table: SpecTable, fallback: string): string {
  const idLeaf = String(table.recordIdField ?? "").split(".").pop() ?? "";
  const idColumn = table.columns.find((column) => column.api.split(".").pop() === idLeaf);
  if (idColumn) return apiOwner(idColumn.api);
  const counts = new Map<string, number>();
  for (const column of table.columns) {
    const owner = apiOwner(column.api);
    if (!owner) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [owner, count] of counts) {
    if (count > bestCount) { best = owner; bestCount = count; }
  }
  return best;
}

/** The leader whose ids a parent-scoped fan-out must wait for. */
function fanOutParentLeader(
  plan: ReturnType<typeof buildScanPlan>,
  parentResource: string | undefined,
): readonly string[] {
  if (!parentResource) return [];
  const parent = plan.groups.find((g) => g.resource === parentResource);
  return parent ? [parent.leader.id] : [];
}

export type LightspeedStream = StreamContract &
  Readonly<{
    /** The resource actually walked to obtain this stream's rows. */
    scanResource: string;
    /** Dot path when this stream is a nested array inside its parent's payload. */
    derivedFrom: string | null;
    /**
     * How rows are obtained: `walk` triggers the request, `records` projects 1:1
     * from the leader's records, `nested` explodes an array at `derivedFrom`, and
     * `fan_out` iterates parent ids against a parent-scoped endpoint.
     */
    projection: "walk" | "records" | "nested" | "fan_out";
    /** True when this stream triggers the walk rather than riding one. */
    isScanLeader: boolean;
  }>;

function toStream(table: SpecTable, plan: ReturnType<typeof buildScanPlan>): LightspeedStream {
  const group = plan.groups.find((g) => g.members.some((m) => m.table.id === table.id));
  const member = group?.members.find((m) => m.table.id === table.id);
  const fanOut = plan.fanOuts.find((f) => f.table.id === table.id);

  const scanResource = group?.resource ?? fanOut?.parentResource ?? "";
  const isScanLeader = Boolean(group && group.leader.id === table.id);

  return {
    id: table.id,
    // The stream's OWN vendor resource — the root every one of its columns is
    // addressed under — not the resource it is walked from. Rows are recorded
    // and referenced by (sourceObjectType, sourceRecordId), so a nested child
    // keeping its parent's resource would conflate Sale 5 with SaleLine 5.
    resource: ownResource(table, scanResource),
    endpoint: group ? group.path : (fanOut?.endpoint ?? ""),
    // Must name a field the vendor actually returns: the transform reads it
    // from the staged row by its source-field name, and a snake_case column name
    // would be filtered out of the projection and read as a missing id.
    recordIdField: resolveRecordIdField(table),
    ...(modifiedField(table) ? { modifiedField: modifiedField(table) } : {}),
    ...(group && group.relations.length > 0 ? { queryJoins: [...group.relations] } : {}),
    // Ids are immutable, so a keyset walk cannot lose a record to mid-walk edits.
    pagination: group?.keysetCapable ? "resource_id_keyset" : "vendor_cursor",
    backfillStrategy: backfillStrategy(table),
    lateEditStrategy: lateEditStrategy(table),
    deletionStrategy: deletionStrategy(table),
    sourceTotalStrategy: "count_distinct_complete_scan",
    ...(fanOut ? { availability: "optional" as const } : {}),
    // A derived stream cannot run before the walk that produces its payload, and
    // a parent-scoped fan-out cannot run before the parent ids it iterates exist.
    dependencies: isScanLeader
      ? []
      : group
        ? [group.leader.id]
        : fanOutParentLeader(plan, fanOut?.parentResource),
    productDomains: [PRODUCT_DOMAIN[table.domain] ?? "sales"],
    // A stream with no mapper of its own emits only a metadata observation, so
    // it must declare exactly that and nothing it cannot produce.
    canonicalTargets: (MAPPED_STREAM_TARGETS[table.id] ?? ["metadata"]) as StreamContract["canonicalTargets"],
    authorityConcept: (MAPPED_STREAM_AUTHORITY[table.id]
      ?? AUTHORITY[table.domain]
      ?? "operational_sales") as StreamContract["authorityConcept"],
    // A balance snapshot is a fresh observation even when the payload is byte
    // identical, because the meaningful fact is the date it was observed on.
    ...(table.additivity === "last_value_over_time" ? { reprocessIdenticalPayloadOnNewBatch: true } : {}),
    scanResource,
    derivedFrom: member?.projectFrom ?? null,
    projection: isScanLeader
      ? "walk"
      : fanOut
        ? "fan_out"
        : member?.projection === "nested"
          ? "nested"
          : "records",
    isScanLeader,
  };
}

export function buildStreams(tables: readonly SpecTable[] = SPEC_TABLES): readonly LightspeedStream[] {
  const plan = buildScanPlan(tables);
  const streams = tables.map((table) => toStream(table, plan));

  const ids = new Set<string>();
  for (const stream of streams) {
    if (ids.has(stream.id)) {
      throw new Error(`Duplicate stream id ${stream.id}: one of them would never stage rows.`);
    }
    ids.add(stream.id);
  }
  for (const stream of streams) {
    for (const dependency of stream.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`Stream ${stream.id} depends on unknown stream ${dependency}.`);
      }
      if (dependency === stream.id) {
        throw new Error(`Stream ${stream.id} depends on itself.`);
      }
    }
  }
  return streams;
}

export const LIGHTSPEED_STREAMS: readonly LightspeedStream[] = buildStreams();

/** Streams that trigger a walk, in the order the planner will run them. */
export const SCAN_LEADERS: readonly LightspeedStream[] = LIGHTSPEED_STREAMS.filter(
  (s) => s.isScanLeader,
);

/** Streams served from a leader's page cache rather than their own request. */
export const DERIVED_STREAMS: readonly LightspeedStream[] = LIGHTSPEED_STREAMS.filter(
  (s) => !s.isScanLeader,
);
