/**
 * Xero stream contracts, derived from the table spec.
 *
 * `staging.ts` builds one table per stream, so every spec table becomes a
 * stream contract. They are generated rather than hand-written: a hand-kept
 * list drifts from the spec, and a drifted stream is a table that silently
 * stages nothing.
 *
 * Fetching is grouped: members of a scan group are projected from the same
 * endpoint walk, and fan-out streams iterate parent ids against parent-scoped
 * endpoints under the org's daily request budget.
 */
import type { StreamContract } from "../../packages/connector-sdk/src/contract.js";
import {
  XERO_SPEC_TABLES,
  buildXeroScanPlan,
  xeroSourceField,
  type XeroSpecTable,
} from "./scan-plan.js";

/**
 * Canonical targets for the streams whose mappers predate the spec. The mapper
 * is the authority on what it emits: a stream declaring less than its mapper
 * produces is rejected at transform time as a target mismatch. These are the
 * executable values carried over from the founding 11-stream manifest.
 */
const MAPPED_STREAM_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  xero_organisations: ["legal_entity"],
  xero_accounts: ["gl_account"],
  xero_contacts: ["person", "customer_account", "supplier", "identity_hint", "metadata"],
  xero_invoices: ["finance_invoice_line"],
  xero_credit_notes: ["finance_invoice_line", "event_link"],
  xero_payments: ["event_link", "metadata"],
  xero_bank_transactions: ["finance_bank_transaction"],
  xero_manual_journals: ["finance_journal_line", "metadata"],
  xero_journals: ["finance_journal_line", "event_link", "metadata"],
  xero_tax_rates: ["tax_code"],
  xero_tracking_categories: ["location", "identity_hint", "metadata"],
});

/** Authority concept for the aliased legacy mappers — the executable truth. */
const MAPPED_STREAM_AUTHORITY: Readonly<Record<string, StreamContract["authorityConcept"]>> =
  Object.freeze({
    xero_organisations: "statutory_finance",
    xero_accounts: "statutory_finance",
    xero_contacts: "statutory_finance",
    xero_invoices: "statutory_finance",
    xero_credit_notes: "statutory_finance",
    xero_payments: "cash_settlement",
    xero_bank_transactions: "cash_settlement",
    xero_manual_journals: "statutory_finance",
    xero_journals: "statutory_finance",
    xero_tax_rates: "statutory_finance",
    xero_tracking_categories: "statutory_finance",
  });

/** Product-facing readiness domain for each spec domain. */
const PRODUCT_DOMAIN: Readonly<Record<string, StreamContract["productDomains"][number]>> = {
  invoicing: "accounting",
  payments_credits: "accounting",
  banking: "accounting",
  purchasing_items: "accounting",
  ledger_config: "accounting",
  contacts_dir: "customers",
  org_meta: "accounting",
  assets: "accounting",
  projects: "accounting",
  files: "accounting",
  payroll_au_people: "workforce",
  payroll_au_runs: "workforce",
  payroll_uk_people: "workforce",
  payroll_uk_runs: "workforce",
  payroll_nz_people: "workforce",
  payroll_nz_runs: "workforce",
};

/**
 * Governing source-authority concept per spec domain. Payroll time observation
 * streams override to worked_hours below; payroll money artifacts are statutory
 * payroll records and stay statutory_finance.
 */
const AUTHORITY: Readonly<Record<string, StreamContract["authorityConcept"]>> = {
  invoicing: "statutory_finance",
  payments_credits: "cash_settlement",
  banking: "cash_settlement",
  purchasing_items: "statutory_finance",
  ledger_config: "statutory_finance",
  contacts_dir: "statutory_finance",
  org_meta: "statutory_finance",
  assets: "statutory_finance",
  projects: "statutory_finance",
  files: "statutory_finance",
  payroll_au_people: "statutory_finance",
  payroll_au_runs: "statutory_finance",
  payroll_uk_people: "statutory_finance",
  payroll_uk_runs: "statutory_finance",
  payroll_nz_people: "statutory_finance",
  payroll_nz_runs: "statutory_finance",
};

/** Time-observation streams speak for hours worked, not statutory money. */
const WORKED_HOURS_STREAM = /timesheet|time_entries|leave_application|working_pattern/;

/**
 * A stream carrying a modified watermark can be swept for late edits by that
 * field. One that cannot must be re-snapshotted (reference data) or is
 * append-only by nature (immutable ledger observations).
 */
function lateEditStrategy(table: XeroSpecTable): StreamContract["lateEditStrategy"] {
  if (table.source.pagination === "offset") return "append_only";
  if (table.source.modifiedField) return "modified_field";
  return table.additivity === "additive" ? "append_only" : "full_snapshot";
}

/**
 * Only a source that can be enumerated authoritatively may retire an identity.
 * Xero soft-deletes documents behind Status (DELETED/VOIDED stay visible) and
 * archives directory records; journals are immutable; unpaged reference sets
 * are re-snapshotted and swept by full identity scan.
 */
function deletionStrategy(table: XeroSpecTable): StreamContract["deletionStrategy"] {
  if (table.source.pagination === "offset") return "immutable_append_only";
  const hasStatus = table.columns.some((column) =>
    /^(Status|ContactStatus)$/.test(xeroSourceField(column)),
  );
  if (hasStatus) return "soft_delete";
  if (table.additivity === "additive" && !table.source.modifiedField) return "immutable_append_only";
  return "authoritative_identity_scan";
}

/**
 * Time-windowed backfill needs a vendor-side `where` filter and a business
 * date to window on; the journals feed walks its monotonic offset to
 * exhaustion; everything else is snapshotted once with completion evidence.
 */
function backfillStrategy(table: XeroSpecTable): StreamContract["backfillStrategy"] {
  if (table.source.pagination === "offset") return "exhaustive_offset";
  const hasBusinessDate = table.columns.some((column) => {
    const field = xeroSourceField(column);
    return field === "Date" || field === "DateOfPayment" || field === "PaymentDate";
  });
  if (
    table.source.pagination === "page" &&
    table.source.whereFilterable &&
    table.source.modifiedField &&
    hasBusinessDate
  ) {
    return "time_windowed";
  }
  return "snapshot";
}

export type XeroStream = StreamContract &
  Readonly<{
    /** The read operation actually walked to obtain this stream's rows. */
    endpointOp: string;
    /** Dot path (relative to the walked record) when rows are a nested array. */
    derivedFrom: string | null;
    projection: "walk" | "nested" | "fan_out";
    isScanLeader: boolean;
    specDomain: string;
  }>;

function toStream(
  table: XeroSpecTable,
  plan: ReturnType<typeof buildXeroScanPlan>,
): XeroStream {
  const group = plan.groups.find((candidate) =>
    candidate.members.some((member) => member.table.id === table.id),
  );
  const member = group?.members.find((candidate) => candidate.table.id === table.id);
  const fanOut = plan.fanOuts.find((candidate) => candidate.table.id === table.id);
  const fanOutHost = plan.fanOuts.find((candidate) =>
    candidate.members.some((m) => m.table.id === table.id),
  );
  const fanOutMember = fanOutHost?.members.find((m) => m.table.id === table.id);
  const isScanLeader = Boolean(group && group.leader.id === table.id);

  // A member's walk mechanics follow the walk that actually carries its rows:
  // journal lines page by the Journals offset, payslip line families ride the
  // payslip fan-out.
  const walkPagination = group?.pagination ?? table.source.pagination;
  const paginationKind: StreamContract["pagination"] =
    walkPagination === "offset"
      ? "offset"
      : walkPagination === "none"
        ? "none"
        : "page";

  const authority = WORKED_HOURS_STREAM.test(table.id)
    ? ("worked_hours" as const)
    : (MAPPED_STREAM_AUTHORITY[table.id] ?? AUTHORITY[table.domain] ?? "statutory_finance");

  return {
    id: table.id,
    resource: group?.resource ?? fanOut?.table.source.envelope ?? table.source.envelope ?? table.id,
    endpoint: (group?.endpointOp ?? table.source.endpointOp).replace(/^GET\s+\//, ""),
    // Must name a field the projection actually emits: the transform reads the
    // staged row's identity by source-field name.
    recordIdField: resolveRecordIdField(table),
    ...(table.source.modifiedField ? { modifiedField: table.source.modifiedField } : {}),
    pagination: paginationKind,
    backfillStrategy: backfillStrategy(table),
    lateEditStrategy: lateEditStrategy(table),
    deletionStrategy: deletionStrategy(table),
    sourceTotalStrategy: "count_distinct_complete_scan",
    ...(availabilityOf(table) === "optional" ? { availability: "optional" as const } : {}),
    // A derived stream cannot run before the walk that produces its payload,
    // and a fan-out cannot run before the parent ids it iterates exist.
    dependencies: isScanLeader
      ? []
      : group
        ? [group.leader.id]
        : fanOut
          ? (fanOut.parentTable ? [fanOut.parentTable] : [])
          : fanOutHost
            ? [fanOutHost.table.id]
            : [],
    productDomains: [PRODUCT_DOMAIN[table.domain] ?? "accounting"],
    // The mapper is the authority on what it emits: aliased founding streams
    // declare their mapper's targets, and every other spec stream declares
    // exactly the governed metadata observation its fallthrough mapper
    // produces. The spec's richer canonicalTargets remain documentation until
    // a dedicated mapper exists.
    canonicalTargets: (MAPPED_STREAM_TARGETS[table.id] ?? ["metadata"]) as StreamContract["canonicalTargets"],
    authorityConcept: authority,
    // A balance snapshot is a fresh observation even when the payload is byte
    // identical, because the meaningful fact is the date it was observed on.
    ...(table.additivity === "last_value_over_time"
      ? { reprocessIdenticalPayloadOnNewBatch: true }
      : {}),
    endpointOp: table.source.endpointOp,
    derivedFrom: member?.projectFrom ?? fanOutMember?.projectFrom ?? null,
    projection: isScanLeader ? "walk" : fanOut || fanOutHost ? "fan_out" : "nested",
    isScanLeader,
    specDomain: table.domain,
  };
}

/**
 * Region- and module-gated surfaces may be durably absent for a tenant: a UK
 * org has no AU payroll, a Starter org may lack Projects, journals need the
 * Advanced grant, fan-outs are budget-priced. Only the accounting core and the
 * tenant connection inventory are unconditionally required.
 */
function availabilityOf(table: XeroSpecTable): "required" | "optional" {
  if (table.source.availability === "optional") return "optional";
  if (table.source.api === "accounting" || table.source.api === "identity") return "required";
  return "optional";
}

function resolveRecordIdField(table: XeroSpecTable): string {
  const clean = (value: string | null | undefined): string | null => {
    const leaf = String(value ?? "").trim();
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(leaf) ? leaf : null;
  };
  const declared = clean(table.recordIdField);
  if (declared) return declared;
  // Fall back to the first primary-key column's staged field name.
  const pk = table.primaryKey[0];
  const pkColumn = table.columns.find((column) => column.name === pk);
  if (pkColumn) {
    const field = clean(xeroSourceField(pkColumn));
    if (field) return field;
  }
  return clean(table.columns[0] ? xeroSourceField(table.columns[0]) : null) ?? "id";
}

export function buildXeroStreams(
  tables: readonly XeroSpecTable[] = XERO_SPEC_TABLES,
): readonly XeroStream[] {
  const plan = buildXeroScanPlan(tables);
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

export const XERO_STREAMS: readonly XeroStream[] = buildXeroStreams();

/** Streams that trigger a walk, in dependency order for the planner. */
export const XERO_SCAN_LEADERS: readonly XeroStream[] = XERO_STREAMS.filter(
  (stream) => stream.isScanLeader,
);

/** Streams served from a leader's walk or a parent-scoped fan-out. */
export const XERO_DERIVED_STREAMS: readonly XeroStream[] = XERO_STREAMS.filter(
  (stream) => !stream.isScanLeader,
);
