"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OperatorFleet,
  OperatorFleetConnection,
  OperatorPipeline,
  OperatorPipelineDetail,
  OperatorPipelineStage,
  OperatorRowSample,
} from "@/services/control-plane/src/operator-repository";
import styles from "../dash.module.css";

type DetailRow = Readonly<Record<string, unknown>>;
type CellKind = "text" | "state" | "time" | "number" | "percent" | "bytes" | "boolean" | "code" | "json" | "connector" | "quality";
type DetailColumn = Readonly<{ key: string; label: string; kind?: CellKind }>;

const PIPELINE_STAGES = Object.freeze([
  { key: "connections", label: "Connections", detail: "authorised sources" },
  { key: "streams", label: "Streams", detail: "cursor positions" },
  { key: "raw", label: "Raw", detail: "batch manifests" },
  { key: "staging", label: "Staging", detail: "typed source tables" },
  { key: "canonical", label: "Canonical", detail: "facts and bridges" },
  { key: "marts", label: "Marts", detail: "query-ready grains" },
  { key: "quality", label: "Quality", detail: "named checks" },
  { key: "readiness", label: "Readiness", detail: "domain states" },
] satisfies readonly Readonly<{ key: OperatorPipelineStage; label: string; detail: string }>[]);

const OPERATION_STAGES = Object.freeze([
  { key: "runs", label: "Recent runs" },
  { key: "jobs", label: "Jobs & attempts" },
  { key: "quarantine", label: "Quarantine" },
  { key: "budgets", label: "Vendor budgets" },
  { key: "semantic_inbox", label: "Semantic inbox" },
] satisfies readonly Readonly<{ key: OperatorPipelineStage; label: string }>[]);

const STAGE_COPY: Readonly<Record<OperatorPipelineStage, Readonly<{ eyebrow: string; title: string; description: string }>>> = {
  connections: { eyebrow: "SOURCE EDGE", title: "Connections and webhooks", description: "Authorisation health and verified delivery metadata. Credential bodies are never exposed." },
  streams: { eyebrow: "EXTRACTION", title: "Stream cursor ledger", description: "Every cursor, watermark and most recent successful delta, grouped by source." },
  raw: { eyebrow: "IMMUTABLE LINEAGE", title: "Raw batch manifests", description: "The bounded manifest trail from vendor extraction through analytical landing." },
  staging: { eyebrow: "TYPED LANDING", title: "Staging snapshots", description: "Post-sync row-count and freshness snapshots projected from the analytical cell." },
  canonical: { eyebrow: "BUSINESS TRUTH", title: "Canonical facts, dimensions and bridges", description: "Source-neutral table snapshots and their latest invariant envelope." },
  marts: { eyebrow: "QUERY SURFACE", title: "Governed marts", description: "Query-ready aggregate grains and the freshness of their last projection." },
  quality: { eyebrow: "QUALITY GATES", title: "Named quality states", description: "The latest projected connector, canonical, bridge and domain check states." },
  readiness: { eyebrow: "ANSWERABILITY", title: "Per-domain readiness", description: "The same readiness state and reason injected into governed answer context." },
  runs: { eyebrow: "SYNC LEDGER", title: "Recent sync runs", description: "Extraction, incremental and reconciliation outcomes, newest first." },
  jobs: { eyebrow: "ORCHESTRATION", title: "Jobs and attempt history", description: "Durable requests, append-only worker attempts and canonical transform jobs." },
  quarantine: { eyebrow: "DEAD LETTERS", title: "Quarantine ledger", description: "Validation failures, replay state and their manifest lineage anchors." },
  budgets: { eyebrow: "VENDOR LIMITS", title: "Rate budget windows", description: "Latest durable request counters, reset windows and enforced cooldowns." },
  semantic_inbox: { eyebrow: "SEMANTIC OPERATIONS", title: "Source-field promotion inbox", description: "Durably relayed exploration candidates and the bounded tenant recovery scan. Customer question content is never retained." },
};

const DETAIL_COLUMNS: Readonly<Record<string, readonly DetailColumn[]>> = {
  connections: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "display_name", label: "Account" },
    { key: "status", label: "Connection", kind: "state" },
    { key: "auth_health", label: "Authorisation", kind: "state" },
    { key: "token_expires_at", label: "Token expires", kind: "time" },
    { key: "last_checked_at", label: "Last checked", kind: "time" },
    { key: "last_rotated_at", label: "Last rotation", kind: "time" },
    { key: "granted_scope_count", label: "Scopes", kind: "number" },
    { key: "external_account_reference", label: "Vendor account", kind: "code" },
    { key: "connection_id", label: "Connection ID", kind: "code" },
  ],
  webhooks: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "status", label: "Status", kind: "state" },
    { key: "routed_streams", label: "Routed streams", kind: "json" },
    { key: "received_at", label: "Received", kind: "time" },
    { key: "queued_at", label: "Queued", kind: "time" },
    { key: "webhook_receipt_id", label: "Receipt ID", kind: "code" },
    { key: "connection_id", label: "Connection ID", kind: "code" },
  ],
  streams: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "stream", label: "Stream" },
    { key: "backfill_complete", label: "Backfill", kind: "boolean" },
    { key: "last_successful_sync_at", label: "Last success", kind: "time" },
    { key: "source_watermark", label: "Source watermark", kind: "time" },
    { key: "last_delta_records", label: "Last delta", kind: "number" },
    { key: "last_delta_quarantine", label: "Rejected", kind: "number" },
    { key: "last_delta_finished_at", label: "Delta finished", kind: "time" },
    { key: "cursor_value", label: "Cursor", kind: "json" },
    { key: "connection_id", label: "Connection ID", kind: "code" },
  ],
  manifests: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "stream", label: "Stream" },
    { key: "landing_status", label: "Landing", kind: "state" },
    { key: "record_count", label: "Raw rows", kind: "number" },
    { key: "staged_record_count", label: "Staged", kind: "number" },
    { key: "quarantine_count", label: "Rejected", kind: "number" },
    { key: "compressed_bytes", label: "Compressed", kind: "bytes" },
    { key: "extracted_at", label: "Extracted", kind: "time" },
    { key: "analytical_committed_at", label: "Committed", kind: "time" },
    { key: "batch_id", label: "Batch ID", kind: "code" },
    { key: "sync_run_id", label: "Run ID", kind: "code" },
    { key: "content_hash", label: "Content hash", kind: "code" },
    { key: "schema_fingerprint", label: "Schema fingerprint", kind: "code" },
    { key: "cursor_start", label: "Cursor start", kind: "json" },
    { key: "cursor_end", label: "Cursor end", kind: "json" },
    { key: "object_keys", label: "Raw object keys", kind: "json" },
    { key: "landing_error_code", label: "Landing error", kind: "code" },
  ],
  staging: [
    { key: "schema_name", label: "Schema", kind: "code" },
    { key: "table_name", label: "Table", kind: "code" },
    { key: "row_count", label: "Rows", kind: "number" },
    { key: "max_event_at", label: "Max event", kind: "time" },
    { key: "max_ingested_at", label: "Max ingested", kind: "time" },
    { key: "snapshot_at", label: "Snapshot", kind: "time" },
    { key: "invariant_status", label: "Checks", kind: "quality" },
  ],
  canonical: [
    { key: "table_name", label: "Fact / dimension / bridge", kind: "code" },
    { key: "row_count", label: "Rows", kind: "number" },
    { key: "max_event_at", label: "Max event", kind: "time" },
    { key: "max_ingested_at", label: "Max ingested", kind: "time" },
    { key: "snapshot_at", label: "Snapshot", kind: "time" },
    { key: "invariant_status", label: "Checks", kind: "quality" },
  ],
  marts: [
    { key: "table_name", label: "Mart", kind: "code" },
    { key: "row_count", label: "Rows", kind: "number" },
    { key: "max_event_at", label: "Max event", kind: "time" },
    { key: "max_ingested_at", label: "Refreshed", kind: "time" },
    { key: "snapshot_at", label: "Snapshot", kind: "time" },
    { key: "invariant_status", label: "Checks", kind: "quality" },
  ],
  quality: [
    { key: "check_id", label: "Named check", kind: "code" },
    { key: "status", label: "State", kind: "state" },
    { key: "snapshot_at", label: "Observed", kind: "time" },
  ],
  readiness: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "domain", label: "Domain" },
    { key: "state", label: "State", kind: "state" },
    { key: "progress", label: "Progress", kind: "percent" },
    { key: "data_ready_through", label: "Ready through", kind: "time" },
    { key: "backfill_complete", label: "Backfill", kind: "boolean" },
    { key: "reason_code", label: "Reason", kind: "code" },
    { key: "reason_detail", label: "Detail" },
    { key: "evaluated_at", label: "Evaluated", kind: "time" },
  ],
  runs: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "job_type", label: "Job type" },
    { key: "stream", label: "Stream" },
    { key: "status", label: "Status", kind: "state" },
    { key: "attempt_number", label: "Attempt", kind: "number" },
    { key: "record_count", label: "Rows", kind: "number" },
    { key: "quarantine_count", label: "Rejected", kind: "number" },
    { key: "started_at", label: "Started", kind: "time" },
    { key: "finished_at", label: "Finished", kind: "time" },
    { key: "error_code", label: "Error", kind: "code" },
    { key: "sync_run_id", label: "Run ID", kind: "code" },
  ],
  sync_jobs: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "job_type", label: "Job type" },
    { key: "priority", label: "Priority", kind: "state" },
    { key: "status", label: "Status", kind: "state" },
    { key: "attempt_count", label: "Attempts", kind: "number" },
    { key: "available_at", label: "Available", kind: "time" },
    { key: "last_claimed_at", label: "Last claimed", kind: "time" },
    { key: "completed_at", label: "Completed", kind: "time" },
    { key: "last_error_code", label: "Error", kind: "code" },
    { key: "job_request_id", label: "Job ID", kind: "code" },
  ],
  job_attempts: [
    { key: "attempt_number", label: "Attempt", kind: "number" },
    { key: "outcome", label: "Outcome", kind: "state" },
    { key: "worker_id", label: "Worker", kind: "code" },
    { key: "started_at", label: "Started", kind: "time" },
    { key: "finished_at", label: "Finished", kind: "time" },
    { key: "visibility_deadline", label: "Lease deadline", kind: "time" },
    { key: "error_code", label: "Error", kind: "code" },
    { key: "job_attempt_id", label: "Attempt ID", kind: "code" },
    { key: "job_request_id", label: "Job ID", kind: "code" },
  ],
  transform_jobs: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "stream", label: "Stream" },
    { key: "domains", label: "Domains", kind: "json" },
    { key: "status", label: "Status", kind: "state" },
    { key: "attempt_count", label: "Attempts", kind: "number" },
    { key: "mapping_version", label: "Mapping", kind: "code" },
    { key: "backfill_complete", label: "Backfill", kind: "boolean" },
    { key: "started_at", label: "Started", kind: "time" },
    { key: "completed_at", label: "Completed", kind: "time" },
    { key: "last_error_code", label: "Error", kind: "code" },
    { key: "batch_id", label: "Batch ID", kind: "code" },
  ],
  quarantine: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "stream", label: "Stream" },
    { key: "source_object_type", label: "Object" },
    { key: "status", label: "Status", kind: "state" },
    { key: "error_code", label: "Error", kind: "code" },
    { key: "error_path", label: "Path", kind: "code" },
    { key: "error_summary", label: "Summary" },
    { key: "created_at", label: "Created", kind: "time" },
    { key: "resolved_at", label: "Resolved", kind: "time" },
    { key: "batch_id", label: "Batch ID", kind: "code" },
    { key: "sync_run_id", label: "Run ID", kind: "code" },
    { key: "source_record_id", label: "Source record", kind: "code" },
  ],
  budgets: [
    { key: "connector_key", label: "Connector", kind: "connector" },
    { key: "budget_key", label: "Budget", kind: "code" },
    { key: "requests_used", label: "Used", kind: "number" },
    { key: "request_limit", label: "Limit", kind: "number" },
    { key: "remaining", label: "Remaining", kind: "number" },
    { key: "window_started_at", label: "Window start", kind: "time" },
    { key: "window_ends_at", label: "Window end", kind: "time" },
    { key: "vendor_reset_at", label: "Vendor reset", kind: "time" },
    { key: "blocked_until", label: "Blocked until", kind: "time" },
    { key: "emission_interval_ms", label: "Drip (ms)", kind: "number" },
    { key: "burst_capacity", label: "Burst", kind: "number" },
  ],
  semantic_inbox: [
    { key: "connector_id", label: "Connector", kind: "connector" },
    { key: "field_reference", label: "Documented field", kind: "code" },
    { key: "topic_hint", label: "Metric concept", kind: "code" },
    { key: "status", label: "Review state", kind: "state" },
    { key: "occurrence_count", label: "Occurrences", kind: "number" },
    { key: "delivery_count", label: "Deliveries", kind: "number" },
    { key: "first_seen_at", label: "First seen", kind: "time" },
    { key: "last_seen_at", label: "Last seen", kind: "time" },
    { key: "semantic_inbox_item_id", label: "Inbox ID", kind: "code" },
    { key: "connection_id", label: "Connection ID", kind: "code" },
  ],
  promotion_relay: [
    { key: "last_error_code", label: "Relay state", kind: "state" },
    { key: "lease_active", label: "Lease active", kind: "boolean" },
    { key: "last_claimed_count", label: "Claimed", kind: "number" },
    { key: "last_delivered_count", label: "Delivered", kind: "number" },
    { key: "last_failed_count", label: "Failed", kind: "number" },
    { key: "consecutive_failure_count", label: "Failure streak", kind: "number" },
    { key: "last_scanned_at", label: "Last scan", kind: "time" },
    { key: "next_scan_at", label: "Next scan", kind: "time" },
  ],
};

const idKeys = [
  "connection_id", "webhook_receipt_id", "batch_id", "check_id", "sync_run_id",
  "job_request_id", "job_attempt_id", "transform_job_id", "quarantine_item_id", "budget_key",
  "semantic_inbox_item_id",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseFleet(value: unknown): OperatorFleet | null {
  if (!isRecord(value) || !Array.isArray(value.connections) || !Array.isArray(value.workers) || !Array.isArray(value.queues)) return null;
  return value as OperatorFleet;
}

function parsePipeline(value: unknown): OperatorPipeline | null {
  if (!isRecord(value) || !isRecord(value.tenant) || !isRecord(value.stage_counts) || !isRecord(value.operation_counts)) return null;
  return value as OperatorPipeline;
}

function parseDetail(value: unknown): OperatorPipelineDetail | null {
  if (!isRecord(value) || typeof value.stage !== "string" || !Array.isArray(value.groups)) return null;
  return value as OperatorPipelineDetail;
}

function humanize(value: unknown) {
  if (typeof value !== "string" || !value) return "—";
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function connectorLabel(value: unknown) {
  if (value === "lightspeed-r") return "Lightspeed R-Series";
  return humanize(value);
}

function formatTime(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Never";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(numberValue) : "—";
}

function formatBytes(value: unknown) {
  const bytes = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes / 1_000;
  let unit = 0;
  while (scaled >= 1_000 && unit < units.length - 1) {
    scaled /= 1_000;
    unit += 1;
  }
  return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unit]}`;
}

function stringify(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "Unavailable";
  }
}

function shorten(value: string, maximum = 28) {
  if (value.length <= maximum) return value;
  const side = Math.max(6, Math.floor((maximum - 1) / 2));
  return `${value.slice(0, side)}…${value.slice(-side)}`;
}

function qualitySummary(value: unknown) {
  if (!isRecord(value)) return "No checks";
  const states = Object.values(value).filter((state): state is string => typeof state === "string");
  const failures = states.filter((state) => state !== "passed").length;
  return failures ? `${failures} of ${states.length} need attention` : `${states.length} passed`;
}

function stateTone(value: unknown) {
  return typeof value === "string" ? value.toLowerCase().replaceAll(" ", "_") : "unknown";
}

function connectionSeverity(connection: OperatorFleetConnection) {
  const readiness = Object.values(connection.readiness).map(({ state }) => state);
  if (
    connection.status === "blocked"
    || ["expired", "revoked", "error"].includes(connection.auth_health)
    || readiness.includes("blocked")
    || connection.quality_failures.some(({ status }) => status === "failed" || status === "blocked")
  ) return "blocked";
  if (
    connection.status === "degraded"
    || ["unknown", "expiring"].includes(connection.auth_health)
    || readiness.includes("degraded")
    || connection.open_quarantine_count > 0
    || connection.quality_failures.length > 0
    || connection.webhook.gap_recovery_status === "gap_detected"
  ) return "degraded";
  return "healthy";
}

function rowKey(row: DetailRow, index: number) {
  for (const key of idKeys) {
    if (typeof row[key] === "string") return `${key}:${row[key]}`;
  }
  return `row:${index}`;
}

function DetailCell({ value, kind = "text" }: Readonly<{ value: unknown; kind?: CellKind }>) {
  if (kind === "state") {
    return <span className={styles.opsBadge} data-state={stateTone(value)}>{humanize(value)}</span>;
  }
  if (kind === "connector") return <strong className={styles.opsConnector}>{connectorLabel(value)}</strong>;
  if (kind === "time") return <time dateTime={typeof value === "string" ? value : undefined}>{formatTime(value)}</time>;
  if (kind === "number") return <span className={styles.opsNumeric}>{formatNumber(value)}</span>;
  if (kind === "bytes") return <span className={styles.opsNumeric}>{formatBytes(value)}</span>;
  if (kind === "percent") {
    const progress = Math.max(0, Math.min(1, Number(value) || 0));
    return (
      <span className={styles.opsCellProgress} aria-label={`${Math.round(progress * 100)} percent`}>
        <span><i style={{ width: `${progress * 100}%` }} /></span>
        <b>{Math.round(progress * 100)}%</b>
      </span>
    );
  }
  if (kind === "boolean") {
    const complete = value === true;
    return <span className={styles.opsBadge} data-state={complete ? "passed" : "pending"}>{complete ? "Complete" : "In progress"}</span>;
  }
  if (kind === "quality") {
    const summary = qualitySummary(value);
    const needsAttention = isRecord(value) && Object.values(value).some((state) => state !== "passed");
    return <span className={styles.opsBadge} data-state={needsAttention ? "warning" : "passed"}>{summary}</span>;
  }
  if (kind === "code" || kind === "json") {
    const fullValue = stringify(value);
    return <code title={fullValue}>{shorten(fullValue, kind === "json" ? 42 : 28)}</code>;
  }
  return <span title={stringify(value)}>{shorten(stringify(value), 54)}</span>;
}

function parseRowSample(value: unknown): OperatorRowSample | null {
  if (!isRecord(value) || typeof value.revealId !== "string" || typeof value.stage !== "string" ||
      typeof value.schemaName !== "string" || typeof value.tableName !== "string" ||
      !Array.isArray(value.columns) || !value.columns.every((column) => typeof column === "string") ||
      !Array.isArray(value.rows) || !value.rows.every(isRecord) ||
      typeof value.rowCount !== "number" || typeof value.excludedColumnCount !== "number" ||
      value.cellCharacterLimit !== 500) return null;
  return value as OperatorRowSample;
}

function DetailGroup({
  group,
  stage,
  tenantId,
}: Readonly<{
  group: OperatorPipelineDetail["groups"][number];
  stage: OperatorPipelineStage;
  tenantId: string;
}>) {
  const columns = DETAIL_COLUMNS[group.id] ?? [];
  const revealable = stage === "staging" || stage === "canonical" || stage === "marts";
  const [selectedTarget, setSelectedTarget] = useState<Readonly<{ schemaName: string; tableName: string }> | null>(null);
  const [sample, setSample] = useState<OperatorRowSample | null>(null);
  const [sampleError, setSampleError] = useState("");
  const [revealing, setRevealing] = useState(false);
  const sampleAbort = useRef<AbortController | null>(null);

  useEffect(() => () => sampleAbort.current?.abort(), []);

  const chooseTarget = (row: DetailRow) => {
    const schemaName = typeof row.schema_name === "string" ? row.schema_name : "";
    const tableName = typeof row.table_name === "string" ? row.table_name : "";
    if (!schemaName || !tableName) return;
    sampleAbort.current?.abort();
    setSelectedTarget({ schemaName, tableName });
    setSample(null);
    setSampleError("");
  };

  const revealRows = async () => {
    if (!selectedTarget || !revealable) return;
    sampleAbort.current?.abort();
    const controller = new AbortController();
    sampleAbort.current = controller;
    setRevealing(true);
    setSampleError("");
    try {
      const response = await fetch(`/api/admin/pipeline/${encodeURIComponent(tenantId)}/sample`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage, ...selectedTarget }),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json() as { sample?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "The row sample could not be revealed.");
      const parsed = parseRowSample(payload.sample);
      if (!parsed || parsed.stage !== stage || parsed.schemaName !== selectedTarget.schemaName ||
          parsed.tableName !== selectedTarget.tableName) throw new Error("The diagnostic service returned an invalid sample.");
      setSample(parsed);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSample(null);
      setSampleError(error instanceof Error ? error.message : "The row sample could not be revealed.");
    } finally {
      if (sampleAbort.current === controller) {
        sampleAbort.current = null;
        setRevealing(false);
      }
    }
  };

  return (
    <section className={styles.opsDetailGroup} aria-labelledby={`operator-group-${group.id}`}>
      <header>
        <div>
          <h4 id={`operator-group-${group.id}`}>{group.label}</h4>
          <p>{group.description}</p>
        </div>
        <span>{group.rows.length} {group.rows.length === 1 ? "record" : "records"}</span>
      </header>
      {group.rows.length ? (
        <div className={styles.opsDetailTableScroll}>
          <div className={styles.opsDetailTable} role="table" aria-label={group.label} style={{ "--ops-columns": columns.length + (revealable ? 1 : 0) } as React.CSSProperties}>
            <div className={styles.opsDetailTableHead} role="row">
              {columns.map((column) => <span role="columnheader" key={column.key}>{column.label}</span>)}
              {revealable ? <span role="columnheader">Customer rows</span> : null}
            </div>
            {group.rows.map((row, index) => (
              <div className={styles.opsDetailTableRow} role="row" key={rowKey(row, index)}>
                {columns.map((column) => (
                  <div role="cell" key={column.key}>
                    <DetailCell value={row[column.key]} kind={column.kind} />
                  </div>
                ))}
                {revealable ? (
                  <div role="cell">
                    <button className={styles.opsRevealButton} type="button" onClick={() => chooseTarget(row)}>
                      Reveal sample
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : <div className={styles.opsEmpty}>No operational metadata has been recorded for this view.</div>}
      {selectedTarget ? (
        <section className={styles.opsRevealPanel} aria-label="Explicit customer row reveal" aria-live="polite">
          <header>
            <div><span>EXPLICIT DATA ACCESS</span><h5>{selectedTarget.schemaName}.{selectedTarget.tableName}</h5></div>
            <button type="button" onClick={() => { sampleAbort.current?.abort(); sampleAbort.current = null; setRevealing(false); setSelectedTarget(null); setSample(null); setSampleError(""); }} aria-label="Close row sample">×</button>
          </header>
          {!sample ? (
            <div className={styles.opsRevealConsent}>
              <p>This reads up to three tenant-scoped rows through the audited diagnostic role. Secret-bearing, JSON, binary and tenant identifier columns are excluded.</p>
              <button type="button" onClick={() => void revealRows()} disabled={revealing}>
                {revealing ? "Revealing…" : "Reveal 3 rows"}
              </button>
            </div>
          ) : (
            <>
              <p className={styles.opsRevealNotice}>Audited reveal · {sample.rowCount} {sample.rowCount === 1 ? "row" : "rows"} · {sample.excludedColumnCount} protected or overflow columns excluded · cells capped at {sample.cellCharacterLimit} characters</p>
              {sample.rows.length ? (
                <div className={styles.opsRevealTableScroll}>
                  <div className={styles.opsRevealTable} role="table" aria-label={`Sample rows from ${sample.schemaName}.${sample.tableName}`} style={{ "--ops-sample-columns": sample.columns.length } as React.CSSProperties}>
                    <div role="row">{sample.columns.map((column) => <span role="columnheader" key={column}>{humanize(column)}</span>)}</div>
                    {sample.rows.map((row, index) => (
                      <div role="row" key={`${sample.revealId}-${index}`}>
                        {sample.columns.map((column) => <code role="cell" title={row[column] ?? "Null"} key={column}>{shorten(row[column] ?? "Null", 80)}</code>)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : <div className={styles.opsEmpty}>This tenant has no rows in the selected table.</div>}
            </>
          )}
          {sampleError ? <p className={styles.opsRevealError} role="alert">{sampleError}</p> : null}
        </section>
      ) : null}
    </section>
  );
}

export default function AdminWorkspace() {
  const [fleet, setFleet] = useState<OperatorFleet | null>(null);
  const [pipeline, setPipeline] = useState<OperatorPipeline | null>(null);
  const [detail, setDetail] = useState<OperatorPipelineDetail | null>(null);
  const [activeStage, setActiveStage] = useState<OperatorPipelineStage>("connections");
  const [loadingScope, setLoadingScope] = useState<"fleet" | "pipeline" | "detail" | null>("fleet");
  const [error, setError] = useState("");
  const detailRequest = useRef(0);
  const pipelineRequest = useRef(0);

  const loadFleet = useCallback(async () => {
    setLoadingScope("fleet");
    setError("");
    try {
      const response = await fetch("/api/admin/fleet", { cache: "no-store" });
      const payload = await response.json() as { fleet?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "Fleet status could not be loaded.");
      const parsed = parseFleet(payload.fleet);
      if (!parsed) throw new Error("Fleet status returned an invalid response.");
      setFleet(parsed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Fleet status could not be loaded.");
    } finally {
      setLoadingScope(null);
    }
  }, []);

  const loadStage = useCallback(async (tenantId: string, stage: OperatorPipelineStage) => {
    const requestId = detailRequest.current + 1;
    detailRequest.current = requestId;
    setActiveStage(stage);
    setLoadingScope("detail");
    setError("");
    try {
      const response = await fetch(
        `/api/admin/pipeline/${encodeURIComponent(tenantId)}?stage=${encodeURIComponent(stage)}`,
        { cache: "no-store" },
      );
      const payload = await response.json() as { detail?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "Pipeline detail could not be loaded.");
      const parsed = parseDetail(payload.detail);
      if (!parsed || parsed.stage !== stage) throw new Error("Pipeline detail returned an invalid response.");
      if (detailRequest.current === requestId) setDetail(parsed);
    } catch (loadError) {
      if (detailRequest.current === requestId) {
        setDetail(null);
        setError(loadError instanceof Error ? loadError.message : "Pipeline detail could not be loaded.");
      }
    } finally {
      if (detailRequest.current === requestId) setLoadingScope(null);
    }
  }, []);

  const loadPipeline = useCallback(async (tenantId: string, initialStage: OperatorPipelineStage = "connections") => {
    const requestId = pipelineRequest.current + 1;
    pipelineRequest.current = requestId;
    setLoadingScope("pipeline");
    setError("");
    setDetail(null);
    try {
      const response = await fetch(`/api/admin/pipeline/${encodeURIComponent(tenantId)}`, { cache: "no-store" });
      const payload = await response.json() as { pipeline?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "The tenant pipeline could not be loaded.");
      const parsed = parsePipeline(payload.pipeline);
      if (!parsed) throw new Error("The tenant pipeline returned an invalid response.");
      if (pipelineRequest.current !== requestId) return;
      setPipeline(parsed);
      await loadStage(tenantId, initialStage);
    } catch (loadError) {
      if (pipelineRequest.current !== requestId) return;
      setError(loadError instanceof Error ? loadError.message : "The tenant pipeline could not be loaded.");
      setLoadingScope(null);
    }
  }, [loadStage]);

  useEffect(() => {
    const task = window.setTimeout(() => void loadFleet(), 0);
    return () => window.clearTimeout(task);
  }, [loadFleet]);

  const sortedConnections = useMemo(() => [...(fleet?.connections ?? [])].sort((left, right) => {
    const rank = { blocked: 0, degraded: 1, healthy: 2 } as const;
    return rank[connectionSeverity(left)] - rank[connectionSeverity(right)]
      || left.tenant_name.localeCompare(right.tenant_name)
      || left.connector_key.localeCompare(right.connector_key);
  }), [fleet]);

  const fleetSummary = useMemo(() => {
    const connections = fleet?.connections ?? [];
    const queueDepth = (fleet?.queues ?? []).reduce((total, queue) => {
      const value = queue.queue_length ?? queue.total_messages ?? queue.msg_count ?? 0;
      const count = Number(value);
      return total + (Number.isFinite(count) ? count : 0);
    }, 0);
    return {
      blocked: connections.filter((connection) => connectionSeverity(connection) === "blocked").length,
      degraded: connections.filter((connection) => connectionSeverity(connection) === "degraded").length,
      healthyWorkers: (fleet?.workers ?? []).filter(({ healthy }) => healthy).length,
      workers: fleet?.workers.length ?? 0,
      queueDepth,
      quarantine: connections.reduce((total, connection) => total + connection.open_quarantine_count, 0),
    };
  }, [fleet]);

  const leavePipeline = () => {
    pipelineRequest.current += 1;
    detailRequest.current += 1;
    setPipeline(null);
    setDetail(null);
    setActiveStage("connections");
    setError("");
  };

  const currentCopy = STAGE_COPY[activeStage];
  const loading = loadingScope !== null;

  return (
    <section className={styles.opsWorkspace} aria-labelledby="admin-workspace-title">
      <header className={styles.opsHeader}>
        <div>
          <span>OPERATIONS</span>
          <div className={styles.opsTitleRow}>
            <h2 id="admin-workspace-title">{pipeline ? pipeline.tenant.name : "Albert fleet"}</h2>
            {pipeline ? <span className={styles.opsBadge} data-state={pipeline.health}>{humanize(pipeline.health)}</span> : null}
          </div>
          <p>{pipeline ? `Trace ${pipeline.tenant.timezone} operational metadata from source edge to query-ready domains.` : "Cross-tenant health, with blocked and degraded connections sorted to the top."}</p>
          <small>{pipeline
            ? `Pipeline snapshot ${formatTime(pipeline.latest_pipeline_snapshot_at)} · Console refreshed ${formatTime(pipeline.generated_at)}`
            : `Fleet refreshed ${formatTime(fleet?.generated_at)}`}</small>
        </div>
        <div className={styles.opsHeaderActions}>
          {pipeline ? <button type="button" onClick={leavePipeline}>Back to fleet</button> : null}
          <button
            type="button"
            onClick={() => pipeline ? void loadPipeline(pipeline.tenant.tenant_id, activeStage) : void loadFleet()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div className={styles.opsError} role="alert"><strong>Operations data unavailable</strong><span>{error}</span></div> : null}

      {!pipeline ? (
        <>
          <dl className={styles.opsSummary}>
            <div data-severity={fleetSummary.blocked ? "blocked" : "healthy"}><dt>Blocked</dt><dd>{fleetSummary.blocked}</dd></div>
            <div data-severity={fleetSummary.degraded ? "degraded" : "healthy"}><dt>Degraded</dt><dd>{fleetSummary.degraded}</dd></div>
            <div><dt>Connections</dt><dd>{fleet?.connections.length ?? 0}</dd></div>
            <div><dt>Workers healthy</dt><dd>{fleetSummary.healthyWorkers}<small>/{fleetSummary.workers}</small></dd></div>
            <div data-severity={fleetSummary.queueDepth ? "degraded" : "healthy"}><dt>Queue depth</dt><dd>{formatNumber(fleetSummary.queueDepth)}</dd></div>
            <div data-severity={fleetSummary.quarantine ? "degraded" : "healthy"}><dt>Open quarantine</dt><dd>{formatNumber(fleetSummary.quarantine)}</dd></div>
          </dl>

          <div className={styles.opsFleetScroll}>
            <div className={styles.opsFleetTable} role="table" aria-label="Tenant connection fleet">
              <div className={styles.opsFleetHeader} role="row">
                <span role="columnheader">Tenant / connector</span>
                <span role="columnheader">Authorisation</span>
                <span role="columnheader">Readiness</span>
                <span role="columnheader">Streams</span>
                <span role="columnheader">Backfill</span>
                <span role="columnheader">Webhook</span>
                <span role="columnheader">Quarantine</span>
                <span role="columnheader">Quality</span>
                <span role="columnheader">Vendor budget</span>
                <span aria-hidden="true" />
              </div>
              {sortedConnections.map((connection) => {
                const severity = connectionSeverity(connection);
                const readiness = Object.entries(connection.readiness);
                const firstBudget = connection.vendor_budgets[0];
                return (
                  <div className={styles.opsFleetRow} data-severity={severity} role="row" key={connection.connection_id}>
                    <div role="cell"><strong>{connection.tenant_name}</strong><span>{connectorLabel(connection.connector_key)} · {connection.display_name}</span></div>
                    <div role="cell">
                      <span className={styles.opsBadge} data-state={connection.auth_health}>{humanize(connection.auth_health)}</span>
                      <small>{connection.token_expires_at ? `Expires ${formatTime(connection.token_expires_at)}` : "No token expiry reported"}</small>
                    </div>
                    <div className={styles.opsFleetStack} role="cell">
                      {readiness.length ? readiness.slice(0, 4).map(([domain, state]) => (
                        <span key={domain} data-state={state.state}>{humanize(domain)} · {humanize(state.state)}</span>
                      )) : <span>No domains yet</span>}
                      {readiness.length > 4 ? <small>+{readiness.length - 4} more</small> : null}
                    </div>
                    <div className={styles.opsFleetStack} role="cell">
                      {connection.streams.length ? connection.streams.slice(0, 3).map((stream) => (
                        <span key={stream.stream}>{humanize(stream.stream)} · {formatTime(stream.last_successful_sync_at)}</span>
                      )) : <span>No cursors yet</span>}
                      {connection.streams.length > 3 ? <small>+{connection.streams.length - 3} more</small> : null}
                    </div>
                    <div role="cell">
                      <span className={styles.opsFleetProgress} aria-label={`${Math.round(connection.backfill_progress * 100)} percent backfilled`}>
                        <i style={{ width: `${connection.backfill_progress * 100}%` }} />
                      </span>
                      <strong>{Math.round(connection.backfill_progress * 100)}%</strong>
                    </div>
                    <div role="cell">
                      <span className={styles.opsBadge} data-state={connection.webhook.gap_recovery_status}>{humanize(connection.webhook.gap_recovery_status)}</span>
                      <small>{formatTime(connection.webhook.last_received_at)}</small>
                    </div>
                    <div role="cell"><strong>{formatNumber(connection.open_quarantine_count)}</strong><small>open records</small></div>
                    <div role="cell">
                      <strong>{connection.quality_failures.length}</strong>
                      <small>{connection.quality_failures.length ? shorten(connection.quality_failures.map(({ check_id }) => humanize(check_id)).join(", "), 40) : "all projected checks pass"}</small>
                    </div>
                    <div role="cell">
                      <strong>{firstBudget ? `${formatNumber(firstBudget.requests_used)}${firstBudget.request_limit === null ? "" : ` / ${formatNumber(firstBudget.request_limit)}`}` : "—"}</strong>
                      <small>{firstBudget ? humanize(firstBudget.budget_key) : "no budget observed"}</small>
                    </div>
                    <button role="cell" type="button" onClick={() => void loadPipeline(connection.tenant_id)}>Open pipeline</button>
                  </div>
                );
              })}
              {!loading && sortedConnections.length === 0 ? <p className={styles.opsEmpty}>No tenant connections exist yet.</p> : null}
            </div>
          </div>
        </>
      ) : (
        <>
          <nav className={styles.opsPipeline} aria-label="Tenant pipeline stages">
            {PIPELINE_STAGES.map((stage, index) => {
              const active = activeStage === stage.key;
              return (
                <button
                  type="button"
                  key={stage.key}
                  aria-current={active ? "step" : undefined}
                  onClick={() => void loadStage(pipeline.tenant.tenant_id, stage.key)}
                >
                  <span><i>{index + 1}</i><b aria-hidden="true" /></span>
                  <strong>{stage.label}</strong>
                  <em>{formatNumber(pipeline.stage_counts[stage.key] ?? 0)}</em>
                  <small>{stage.detail}</small>
                </button>
              );
            })}
          </nav>

          <nav className={styles.opsOperationNav} aria-label="Tenant operations metadata">
            <span>Operational ledgers</span>
            <div>
              {OPERATION_STAGES.map((stage) => (
                <button
                  type="button"
                  key={stage.key}
                  aria-pressed={activeStage === stage.key}
                  onClick={() => void loadStage(pipeline.tenant.tenant_id, stage.key)}
                >
                  {stage.label}
                  <b>{formatNumber(stage.key === "jobs"
                    ? (pipeline.operation_counts.jobs ?? 0) + (pipeline.operation_counts.attempts ?? 0)
                    : pipeline.operation_counts[stage.key] ?? 0)}</b>
                </button>
              ))}
            </div>
          </nav>

          <section className={styles.opsDetailPanel} aria-busy={loadingScope === "detail"}>
            <header className={styles.opsDetailHeader}>
              <div><span>{currentCopy.eyebrow}</span><h3>{currentCopy.title}</h3><p>{currentCopy.description}</p></div>
              <small>{detail ? `Read ${formatTime(detail.generated_at)}` : loadingScope === "detail" ? "Reading operational metadata…" : "No detail loaded"}</small>
            </header>
            {detail ? detail.groups.map((group) => <DetailGroup group={group} stage={activeStage} tenantId={pipeline.tenant.tenant_id} key={group.id} />) : (
              <div className={styles.opsDetailLoading} role="status">
                <span aria-hidden="true" /><p>{loadingScope === "detail" ? "Loading the audited drill-down…" : "Choose a pipeline stage to inspect its metadata."}</p>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}
