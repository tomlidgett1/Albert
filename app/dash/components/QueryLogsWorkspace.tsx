"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalyticalQueryLogFilter,
  AnalyticalQueryLogItem,
  AnalyticalQueryLogs,
} from "@/services/control-plane/src/query-log-repository";
import styles from "./query-logs.module.css";

const FILTERS = Object.freeze([
  { value: "failures", label: "Failures" },
  { value: "all", label: "All" },
  { value: "succeeded", label: "Successful" },
  { value: "in_progress", label: "In progress" },
] satisfies readonly Readonly<{ value: AnalyticalQueryLogFilter; label: string }>[]);

const STATUS_LABELS: Readonly<Record<AnalyticalQueryLogItem["status"], string>> = {
  succeeded: "Succeeded",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  in_progress: "In progress",
};

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).valueOf();
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.max(0, Math.round(elapsed / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function durationLabel(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function sourceLabel(item: AnalyticalQueryLogItem): string {
  if (item.source === "shopify_admin") return "Shopify Admin";
  if (item.source === "shopifyql") return "ShopifyQL";
  if (item.source === "xero_mcp") return "Xero live report";
  return item.runtime === "codex-app-server" ? "Cube · Codex" : "Cube · Albert";
}

function failureText(item: AnalyticalQueryLogItem): string | null {
  if (item.failureMessage) return item.failureMessage;
  if (item.status === "interrupted") {
    return "A start record exists, but no terminal outcome arrived within 15 minutes. The runtime or request ended mid-query.";
  }
  if (item.status === "in_progress") return "This query has started and has not reported a terminal outcome yet.";
  return null;
}

function questionLabel(item: AnalyticalQueryLogItem): string {
  return item.contextSnapshot.question?.trim() || item.topic || "Query attempt";
}

type LoadState = Readonly<{ kind: "loading" | "ready" | "error"; message?: string }>;

export default function QueryLogsWorkspace({
  onOpenConversation,
}: Readonly<{ onOpenConversation?: (conversationId: string) => void }>) {
  const [filter, setFilter] = useState<AnalyticalQueryLogFilter>("failures");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [logs, setLogs] = useState<AnalyticalQueryLogs | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const requestVersion = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const load = useCallback(async () => {
    const version = ++requestVersion.current;
    setState({ kind: "loading" });
    try {
      const params = new URLSearchParams({ status: filter, limit: "100" });
      if (search) params.set("search", search);
      const response = await fetch(`/api/query-logs?${params.toString()}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null) as { logs?: AnalyticalQueryLogs; error?: string } | null;
      if (!response.ok || !payload?.logs) {
        if (response.status === 403 && version === requestVersion.current) setLogs(null);
        throw new Error(payload?.error ?? "Query logs could not be loaded.");
      }
      if (version !== requestVersion.current) return;
      setLogs(payload.logs);
      setSelectedId((current) => (
        current && payload.logs!.items.some((item) => item.queryAttemptId === current)
          ? current
          : payload.logs!.items[0]?.queryAttemptId ?? null
      ));
      setState({ kind: "ready" });
    } catch (error) {
      if (version !== requestVersion.current) return;
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Query logs could not be loaded.",
      });
    }
  }, [filter, search]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void load());
    return () => window.cancelAnimationFrame(frame);
  }, [load, refreshVersion]);

  const selected = useMemo(
    () => logs?.items.find((item) => item.queryAttemptId === selectedId) ?? logs?.items[0] ?? null,
    [logs, selectedId],
  );
  const selectedFailure = selected ? failureText(selected) : null;

  const copyQuery = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selected.queryDocument, null, 2));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1_500);
  };

  return (
    <div className={styles.workspace}>
      <section className={styles.toolbar} aria-label="Query log controls">
        <div className={styles.segmented} role="group" aria-label="Log status">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <span className={styles.srOnly}>Search query logs</span>
          <input
            type="search"
            value={searchDraft}
            maxLength={120}
            placeholder="Search question, tenant, topic or error"
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </label>
        <button
          className={styles.refresh}
          type="button"
          disabled={state.kind === "loading"}
          onClick={() => setRefreshVersion((current) => current + 1)}
        >
          {state.kind === "loading" ? "Refreshing…" : "Refresh"}
        </button>
      </section>

      {logs ? (
        <dl className={styles.summary} aria-label={`Last ${logs.summary.windowDays} days`}>
          <div>
            <dt>Attempts</dt>
            <dd>{logs.summary.total.toLocaleString("en-AU")}</dd>
          </div>
          <div data-tone={logs.summary.failures > 0 ? "danger" : "neutral"}>
            <dt>Failures</dt>
            <dd>{logs.summary.failures.toLocaleString("en-AU")}</dd>
          </div>
          <div>
            <dt>Failure rate</dt>
            <dd>{(logs.summary.failureRate * 100).toLocaleString("en-AU", { maximumFractionDigits: 1 })}%</dd>
          </div>
          <div>
            <dt>In progress</dt>
            <dd>{logs.summary.inProgress.toLocaleString("en-AU")}</dd>
          </div>
          <div className={styles.summaryNote}>
            <dt className={styles.srOnly}>Window</dt>
            <dd>Rolling {logs.summary.windowDays}-day view · latest 100 matching attempts below</dd>
          </div>
        </dl>
      ) : null}

      {state.kind === "error" && !logs ? (
        <div className={styles.state} role="alert">
          <strong>Logs unavailable</strong>
          <p>{state.message}</p>
          <button type="button" onClick={() => setRefreshVersion((current) => current + 1)}>Try again</button>
        </div>
      ) : state.kind === "loading" && !logs ? (
        <div className={styles.state} role="status">Loading query failures…</div>
      ) : logs && logs.items.length === 0 ? (
        <div className={styles.state}>
          <strong>{filter === "failures" ? "No matching failures" : "No matching query attempts"}</strong>
          <p>{search ? "Try a broader search." : "New attempts will appear here as Albert runs governed queries."}</p>
        </div>
      ) : logs ? (
        <div className={styles.browser}>
          <section className={styles.listPane} aria-label="Query attempts">
            <header>
              <strong>{filter === "failures" ? "Latest failures" : "Latest attempts"}</strong>
              <span>{logs.items.length}</span>
            </header>
            <div className={styles.list}>
              {logs.items.map((item) => (
                <button
                  key={item.queryAttemptId}
                  type="button"
                  className={styles.logRow}
                  aria-current={selected?.queryAttemptId === item.queryAttemptId ? "true" : undefined}
                  onClick={() => {
                    setSelectedId(item.queryAttemptId);
                    setCopyState("idle");
                  }}
                >
                  <span className={styles.rowTop}>
                    <span className={styles.status} data-status={item.status}>{STATUS_LABELS[item.status]}</span>
                    <time dateTime={item.startedAt}>{relativeTime(item.startedAt)}</time>
                  </span>
                  <strong>{questionLabel(item)}</strong>
                  <span className={styles.rowMeta}>{item.tenantName} · {sourceLabel(item)}</span>
                  {failureText(item) ? <small>{failureText(item)}</small> : null}
                </button>
              ))}
            </div>
          </section>

          {selected ? (
            <article className={styles.detail} aria-label="Selected query attempt">
              <header className={styles.detailHeader}>
                <div>
                  <span className={styles.status} data-status={selected.status}>{STATUS_LABELS[selected.status]}</span>
                  <h2>{selected.topic || questionLabel(selected)}</h2>
                  <p>{sourceLabel(selected)} · {selected.tenantName} · {formatTimestamp(selected.startedAt)}</p>
                </div>
                <div className={styles.detailActions}>
                  {onOpenConversation ? (
                    <button type="button" onClick={() => onOpenConversation(selected.conversationId)}>Open conversation</button>
                  ) : null}
                  <button type="button" onClick={() => void copyQuery()}>
                    {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy query"}
                  </button>
                </div>
              </header>

              {selectedFailure ? (
                <section className={styles.failure} data-status={selected.status}>
                  <span>{selected.failureCode || (selected.status === "interrupted" ? "missing_terminal_outcome" : selected.status)}</span>
                  <p>{selectedFailure}</p>
                </section>
              ) : null}

              <dl className={styles.facts}>
                <div><dt>Duration</dt><dd>{durationLabel(selected.executionMs)}</dd></div>
                <div><dt>Rows</dt><dd>{selected.rowCount?.toLocaleString("en-AU") ?? "—"}</dd></div>
                <div><dt>Runtime</dt><dd>{selected.runtime === "codex-app-server" ? "Codex" : "Albert V3"}</dd></div>
                <div><dt>Operation</dt><dd><code>{selected.operation}</code></dd></div>
              </dl>

              <section className={styles.section}>
                <div className={styles.sectionHeading}>
                  <div><span>QUESTION CONTEXT</span><h3>{questionLabel(selected)}</h3></div>
                </div>
                {selected.contextSnapshot.recentTurns.length > 0 ? (
                  <div className={styles.contextTimeline}>
                    {selected.contextSnapshot.recentTurns.map((turn) => (
                    <div key={turn.turnId} className={styles.contextTurn} data-current={turn.turnId === selected.turnId ? "true" : undefined}>
                      <span>Turn {turn.turnNumber}</span>
                      <p>{turn.userMessage}</p>
                      {turn.assistantAnswer ? <blockquote>{turn.assistantAnswer}</blockquote> : null}
                    </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.missingContext}>Question context was not captured for this pre-fix attempt.</p>
                )}
              </section>

              <section className={styles.section}>
                <div className={styles.sectionHeading}>
                  <div><span>GOVERNED QUERY</span><h3>{selected.topic || selected.operation}</h3></div>
                </div>
                <pre tabIndex={0}>{JSON.stringify(selected.queryDocument, null, 2)}</pre>
              </section>

              <details className={styles.identifiers}>
                <summary>Identifiers and result metadata</summary>
                <dl>
                  <div><dt>Attempt</dt><dd><code>{selected.queryAttemptId}</code></dd></div>
                  <div><dt>Conversation</dt><dd><code>{selected.conversationId}</code></dd></div>
                  <div><dt>Turn</dt><dd><code>{selected.turnId}</code></dd></div>
                  <div><dt>Request</dt><dd><code>{selected.correlationId ?? "—"}</code></dd></div>
                  <div><dt>Completed</dt><dd>{formatTimestamp(selected.completedAt)}</dd></div>
                </dl>
                {Object.keys(selected.resultMetadata).length > 0 ? (
                  <pre tabIndex={0}>{JSON.stringify(selected.resultMetadata, null, 2)}</pre>
                ) : null}
              </details>
              <span className={styles.srOnly} aria-live="polite">
                {copyState === "copied" ? "Query copied to clipboard." : copyState === "failed" ? "Query could not be copied." : ""}
              </span>
            </article>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
