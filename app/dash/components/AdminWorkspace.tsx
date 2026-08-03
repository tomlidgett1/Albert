"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "../dash.module.css";

type FleetConnection = Readonly<{
  tenant_id: string;
  tenant_name: string;
  connection_id: string;
  connector_key: string;
  display_name: string;
  status: string;
  auth_health: string;
  last_successful_sync_at?: string | null;
  readiness: Readonly<Record<string, Readonly<{ state?: string; progress?: number | null }>>>;
  open_quarantine_count: number;
  last_webhook_received_at?: string | null;
}>;

type FleetData = Readonly<{
  generated_at: string;
  queues: readonly Readonly<Record<string, unknown>>[];
  workers: readonly Readonly<{
    worker_id: string;
    service_version: string;
    last_seen_at: string;
    active_job_count: number;
    healthy: boolean;
  }>[];
  connections: readonly FleetConnection[];
}>;

type PipelineData = Readonly<{
  tenant: Readonly<{ tenant_id: string; name: string }>;
  connections: readonly Readonly<Record<string, unknown>>[];
  cursors: readonly Readonly<Record<string, unknown>>[];
  readiness: readonly Readonly<Record<string, unknown>>[];
  recent_runs: readonly Readonly<Record<string, unknown>>[];
  jobs: readonly Readonly<Record<string, unknown>>[];
  raw_batches: readonly Readonly<Record<string, unknown>>[];
  quarantine: readonly Readonly<Record<string, unknown>>[];
  vendor_budgets: readonly Readonly<Record<string, unknown>>[];
  pipeline_stats?: readonly Readonly<Record<string, unknown>>[];
  quality_results?: readonly Readonly<Record<string, unknown>>[];
}>;

function asArray(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function parseFleet(value: unknown): FleetData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.connections) || !Array.isArray(data.workers) || !Array.isArray(data.queues)) return null;
  return data as unknown as FleetData;
}

function parsePipeline(value: unknown): PipelineData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!data.tenant || !Array.isArray(data.connections) || !Array.isArray(data.cursors)) return null;
  return data as unknown as PipelineData;
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

function connectorLabel(value: string) {
  if (value === "lightspeed-r") return "Lightspeed R-Series";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function severity(connection: FleetConnection) {
  const readinessStates = Object.values(connection.readiness ?? {}).map(({ state }) => state);
  if (connection.status === "blocked" || readinessStates.includes("blocked")) return "blocked";
  if (connection.status === "degraded" || readinessStates.includes("degraded") || connection.open_quarantine_count > 0) return "degraded";
  return "healthy";
}

export default function AdminWorkspace() {
  const [fleet, setFleet] = useState<FleetData | null>(null);
  const [pipeline, setPipeline] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadFleet = async () => {
    setLoading(true);
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
      setLoading(false);
    }
  };

  useEffect(() => {
    const task = window.setTimeout(() => {
      void loadFleet();
    }, 0);
    return () => window.clearTimeout(task);
  }, []);

  const loadPipeline = async (tenantId: string) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/pipeline/${encodeURIComponent(tenantId)}`, { cache: "no-store" });
      const payload = await response.json() as { pipeline?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "The tenant pipeline could not be loaded.");
      const parsed = parsePipeline(payload.pipeline);
      if (!parsed) throw new Error("The tenant pipeline returned an invalid response.");
      setPipeline(parsed);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The tenant pipeline could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  const fleetSummary = useMemo(() => {
    const connections = fleet?.connections ?? [];
    return {
      blocked: connections.filter((connection) => severity(connection) === "blocked").length,
      degraded: connections.filter((connection) => severity(connection) === "degraded").length,
      healthyWorkers: (fleet?.workers ?? []).filter(({ healthy }) => healthy).length,
      workers: fleet?.workers.length ?? 0,
    };
  }, [fleet]);

  const pipelineStages = pipeline ? [
    { label: "Connections", value: pipeline.connections.length, detail: "authorised source accounts" },
    { label: "Streams", value: pipeline.cursors.length, detail: "durable cursor positions" },
    { label: "Raw", value: pipeline.raw_batches.length, detail: "immutable batch manifests" },
    { label: "Jobs", value: pipeline.jobs.length, detail: "recent orchestration requests" },
    { label: "Canonical", value: asArray(pipeline.pipeline_stats).filter((item) => String(item.schema_name ?? "") === "core").length, detail: "snapshot statistics" },
    { label: "Marts", value: asArray(pipeline.pipeline_stats).filter((item) => String(item.schema_name ?? "") === "mart").length, detail: "query-ready snapshots" },
    { label: "Quality", value: asArray(pipeline.quality_results).length, detail: "named check results" },
    { label: "Ready", value: pipeline.readiness.filter((item) => ["ready_partial", "ready_complete"].includes(String(item.state ?? ""))).length, detail: "queryable domains" },
  ] : [];

  return (
    <section className={styles.adminWorkspace} aria-labelledby="admin-workspace-title">
      <header className={styles.adminHeader}>
        <div>
          <span>OPERATIONS</span>
          <h2 id="admin-workspace-title">{pipeline ? pipeline.tenant.name : "Albert fleet"}</h2>
          <p>{pipeline ? "Trace operational metadata from source connection to query-ready domain." : "Cross-tenant health, ordered by the connections that need attention."}</p>
        </div>
        <div className={styles.adminHeaderActions}>
          {pipeline ? <button type="button" onClick={() => setPipeline(null)}>Back to fleet</button> : null}
          <button type="button" onClick={() => pipeline ? void loadPipeline(pipeline.tenant.tenant_id) : void loadFleet()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {error ? <div className={styles.adminError} role="alert"><strong>Operations data unavailable</strong><span>{error}</span></div> : null}

      {!pipeline ? (
        <>
          <dl className={styles.adminSummary}>
            <div data-severity={fleetSummary.blocked ? "blocked" : "healthy"}><dt>Blocked</dt><dd>{fleetSummary.blocked}</dd></div>
            <div data-severity={fleetSummary.degraded ? "degraded" : "healthy"}><dt>Degraded</dt><dd>{fleetSummary.degraded}</dd></div>
            <div><dt>Connections</dt><dd>{fleet?.connections.length ?? 0}</dd></div>
            <div><dt>Workers healthy</dt><dd>{fleetSummary.healthyWorkers}/{fleetSummary.workers}</dd></div>
          </dl>

          <div className={styles.adminFleetTable} role="table" aria-label="Tenant connection fleet">
            <div className={styles.adminFleetHeader} role="row">
              <span role="columnheader">Tenant / connector</span>
              <span role="columnheader">Authorisation</span>
              <span role="columnheader">Readiness</span>
              <span role="columnheader">Last sync</span>
              <span role="columnheader">Exceptions</span>
              <span aria-hidden="true" />
            </div>
            {(fleet?.connections ?? []).map((connection) => {
              const connectionSeverity = severity(connection);
              const readiness = Object.entries(connection.readiness ?? {});
              return (
                <div className={styles.adminFleetRow} data-severity={connectionSeverity} role="row" key={connection.connection_id}>
                  <div role="cell"><strong>{connection.tenant_name}</strong><span>{connectorLabel(connection.connector_key)} · {connection.display_name}</span></div>
                  <div role="cell"><span className={styles.adminStatus} data-state={connection.auth_health}>{connection.auth_health.replaceAll("_", " ")}</span></div>
                  <div className={styles.adminReadinessCell} role="cell">
                    {readiness.length ? readiness.slice(0, 3).map(([domain, state]) => <span key={domain} data-state={state.state}>{domain.replaceAll("_", " ")} · {state.state?.replaceAll("_", " ")}</span>) : <span>No domains yet</span>}
                  </div>
                  <time role="cell" dateTime={connection.last_successful_sync_at ?? undefined}>{formatTime(connection.last_successful_sync_at)}</time>
                  <div role="cell"><strong>{connection.open_quarantine_count}</strong><span>quarantined</span></div>
                  <button role="cell" type="button" onClick={() => void loadPipeline(connection.tenant_id)}>Open pipeline</button>
                </div>
              );
            })}
            {!loading && fleet?.connections.length === 0 ? <p className={styles.adminEmpty}>No tenant connections exist yet.</p> : null}
          </div>
        </>
      ) : (
        <>
          <div className={styles.adminPipeline} aria-label="Tenant data pipeline">
            {pipelineStages.map((stage, index) => (
              <article key={stage.label}>
                <div><span>{index + 1}</span><i aria-hidden="true" /></div>
                <strong>{stage.label}</strong>
                <b>{stage.value}</b>
                <small>{stage.detail}</small>
              </article>
            ))}
          </div>
          <div className={styles.adminDetailGrid}>
            <section><span>RECENT RUNS</span><strong>{pipeline.recent_runs.length}</strong><p>Latest sync ledger entries retained for drill-down.</p></section>
            <section><span>RAW BATCHES</span><strong>{pipeline.raw_batches.length}</strong><p>Immutable manifests with landing and quarantine counts.</p></section>
            <section data-severity={pipeline.quarantine.length ? "degraded" : "healthy"}><span>QUARANTINE</span><strong>{pipeline.quarantine.length}</strong><p>Malformed source records awaiting replay or review.</p></section>
            <section><span>RATE WINDOWS</span><strong>{pipeline.vendor_budgets.length}</strong><p>Current vendor budget windows recorded by workers.</p></section>
          </div>
        </>
      )}
    </section>
  );
}
