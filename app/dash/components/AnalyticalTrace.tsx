"use client";

import dynamic from "next/dynamic";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  groundedFlintPlanForChart,
  type TraceChartEvent,
  type TraceEvent,
  type TraceProvenance,
  type TraceTableEvent,
} from "@/packages/shared/src";
import { responseVisibleResultIds } from "../lib/answer-presentation";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES } from "./connectors";
import styles from "../dash.module.css";
import {
  parseSafeAnswerLineage,
  type SafeAnswerLineage,
  type TurnLineageReference,
} from "./answer-lineage";
import {
  formatTraceCell,
  isExplainableTraceCell,
} from "./analytical-values";
import { GovernedResultGrid } from "./GovernedResultGrid";

const FlintChartView = dynamic(() => import("./FlintChartView"), {
  ssr: false,
});

type AnalyticalTraceProps = {
  events: readonly TraceEvent[];
  streaming?: boolean;
  runtime?: "fixture" | "openai" | "anthropic";
  lineageReference?: TurnLineageReference;
  onFollowUp?: (prompt: string) => void;
  onClarification?: (label: string, optionId: string) => void;
};

type ExplainSelection = {
  title: string;
  value?: string;
  provenance: TraceProvenance;
};

type LineageState =
  | Readonly<{ kind: "idle"; message: string }>
  | Readonly<{ kind: "loading"; key: string }>
  | Readonly<{ kind: "ready"; key: string; lineage: SafeAnswerLineage }>
  | Readonly<{ kind: "error"; key: string; message: string }>;

const answerStateDescriptions = {
  Verified: "Checked against governed evidence",
  Derived: "Calculated deterministically from governed results",
  Qualified: "Useful answer, with a limitation noted below",
  Exploratory: "From your live Lightspeed or Xero data",
  Clarification: "Albert needs one quick choice before continuing",
  "No data": "The valid question returned no matching records",
  Unavailable: "The required data is not available yet",
} as const;

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatChartDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.trim();
  // Date-only ISO values (YYYY-MM-DD) stay calendar dates; datetimes keep a short time.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value.trim());
  return new Intl.DateTimeFormat("en-AU", dateOnly
    ? { day: "numeric", month: "short", year: "numeric" }
    : { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(date);
}

function isPlaceholderChartRange(value: string) {
  return /^(requested period|unknown|x)$/iu.test(value.trim());
}

function formatChartDateRange(range: Readonly<{ start: string; end: string; label: string }> | undefined) {
  if (!range) return "";
  const start = range.start.trim();
  const end = range.end.trim();
  if (start && end && !isPlaceholderChartRange(start) && !isPlaceholderChartRange(end)) {
    const startLabel = formatChartDate(start);
    const endLabel = formatChartDate(end);
    if (isPlaceholderChartRange(startLabel) || isPlaceholderChartRange(endLabel)) return "";
    return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
  }
  const label = range.label.trim();
  return isPlaceholderChartRange(label) ? "" : label;
}

function ChartTableIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="M3.5 10h17M10 10v9" />
    </svg>
  );
}

function ChartViewIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V5M4 19h16" />
      <path d="M8 15v-3M12 15V8M16 15v-6" />
    </svg>
  );
}

function formatFinalizedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ImmutableLineageSection({
  state,
  onRetry,
}: {
  state: LineageState;
  onRetry: () => void;
}) {
  if (state.kind === "idle") {
    return (
      <section className={styles.traceLineage} aria-label="Immutable answer record">
        <div className={styles.traceLineageHeading}>
          <h5>Immutable answer record</h5>
          <span data-state="pending">PENDING</span>
        </div>
        <p className={styles.traceLineageState}>{state.message}</p>
      </section>
    );
  }

  if (state.kind === "loading") {
    return (
      <section className={styles.traceLineage} aria-label="Immutable answer record">
        <div className={styles.traceLineageHeading}>
          <h5>Immutable answer record</h5>
          <span data-state="loading">CHECKING</span>
        </div>
        <p className={styles.traceLineageState} role="status">Verifying the sealed turn receipt…</p>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className={styles.traceLineage} aria-label="Immutable answer record">
        <div className={styles.traceLineageHeading}>
          <h5>Immutable answer record</h5>
          <span data-state="error">UNAVAILABLE</span>
        </div>
        <div className={styles.traceLineageError} role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={onRetry}>Try again</button>
        </div>
      </section>
    );
  }

  const { lineage } = state;
  return (
    <section className={styles.traceLineage} aria-label="Immutable answer record">
      <div className={styles.traceLineageHeading}>
        <h5>Immutable answer record</h5>
        <span data-state="sealed">SEALED</span>
      </div>
      <p className={styles.traceLineageIntro}>
        Finalized {formatFinalizedAt(lineage.finalizedAt)} · turn {lineage.turnNumber} · {lineage.answerState}
      </p>
      <dl className={styles.traceLineageReceipt}>
        <div>
          <dt>Answer artifact</dt>
          <dd title={lineage.answerArtifactId}>{lineage.answerArtifactId}</dd>
        </div>
        <div>
          <dt>Artifact digest</dt>
          <dd title={lineage.artifactDigest}>{lineage.artifactDigest}</dd>
        </div>
        <div>
          <dt>Trace digest</dt>
          <dd title={lineage.traceDigest}>{lineage.traceDigest}</dd>
        </div>
        {lineage.semanticBundleHash ? (
          <div>
            <dt>Semantic bundle</dt>
            <dd title={lineage.semanticBundleHash}>{lineage.semanticBundleHash}</dd>
          </div>
        ) : null}
      </dl>
      <div className={styles.traceLineageQueries}>
        <h6>Governed query receipts</h6>
        {lineage.queries.length ? (
          <ol>
            {lineage.queries.map((query) => (
              <li key={query.queryAuditId}>
                <div>
                  <strong>{query.topic || (query.route === "semantic" ? "Semantic query" : "Source exploration")}</strong>
                  <span>{query.route.replaceAll("_", " ")} · registry {query.registryVersion} · {query.answerState}</span>
                </div>
                <dl>
                  <div><dt>Compiler</dt><dd title={query.compilerOutputHash}>{query.compilerOutputHash}</dd></div>
                  <div><dt>Result</dt><dd title={query.resultDigest}>{query.resultDigest}</dd></div>
                </dl>
              </li>
            ))}
          </ol>
        ) : (
          <p>No analytical query was executed for this turn.</p>
        )}
      </div>
    </section>
  );
}

function TraceGlyph({ type }: { type: TraceEvent["type"] }) {
  if (type === "table") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 9h18M9 9v11" />
      </svg>
    );
  }

  if (type === "chart") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
      </svg>
    );
  }

  if (type === "validation") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }

  if (type === "query") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </svg>
    );
  }

  if (type === "answer") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m12 3 2.1 6.2L21 12l-6.9 2.8L12 21l-2.1-6.2L3 12l6.9-2.8L12 3Z" />
      </svg>
    );
  }

  if (type === "error") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6M12 17h.01" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ProvenancePanel({
  selection,
  lineageState,
  onRetryLineage,
  onClose,
  panelRef,
  titleId,
}: {
  selection: ExplainSelection;
  lineageState: LineageState;
  onRetryLineage: () => void;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  titleId: string;
}) {
  const { provenance } = selection;

  return (
    <aside ref={panelRef} className={styles.traceExplainPanel} aria-labelledby={titleId}>
      <div className={styles.traceExplainHeader}>
        <div>
          <p>EXPLAIN THIS NUMBER</p>
          <h4 id={titleId}>{selection.title}</h4>
          {selection.value ? <strong>{selection.value}</strong> : null}
        </div>
        <button type="button" aria-label="Close explanation" onClick={onClose}>
          ×
        </button>
      </div>

      <dl className={styles.traceExplainGrid}>
        <div>
          <dt>Time range</dt>
          <dd>{provenance.timeRange.label}</dd>
          <small>{provenance.timeRange.timezone}</small>
        </div>
        <div>
          <dt>Semantic bundle</dt>
          <dd className={styles.traceHash}>{provenance.semanticBundleHash}</dd>
          <small>Identity graph v{provenance.identityGraph.version} · {provenance.identityGraph.hash.slice(0, 10)}</small>
        </div>
      </dl>

      <div className={styles.traceExplainSection}>
        <h5>Sources and freshness</h5>
        <ul>
          {provenance.sources.map((source) => (
            <li key={`${source.connector}-${source.label}`}>
              <span className={styles.traceSourceLogo} aria-hidden="true">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={CONNECTOR_LOGOS[source.connector]} alt="" width={12} height={12} />
              </span>
              <div>
                <strong>{CONNECTOR_NAMES[source.connector]}</strong>
                <small>{source.label}</small>
                <small>Data through {formatTime(source.dataThrough)}</small>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className={styles.traceExplainSection}>
        <h5>Definitions applied</h5>
        <dl className={styles.traceDefinitionList}>
          {provenance.definitions.map((definition) => (
            <div key={definition.metric}>
              <dt>{definition.label}</dt>
              <dd>{definition.definition}</dd>
            </div>
          ))}
        </dl>
      </div>

      {provenance.coverage?.length ? (
        <div className={styles.traceExplainSection}>
          <h5>Coverage checks</h5>
          <ul className={styles.traceCoverageList}>
            {provenance.coverage.map((item) => (
              <li key={item.label}>
                <span>{item.label}</span>
                <strong>{item.unit === "percent" ? `${item.value}%` : item.value}</strong>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ImmutableLineageSection state={lineageState} onRetry={onRetryLineage} />
    </aside>
  );
}

function ResultTable({
  event,
  onExplain,
}: {
  event: TraceTableEvent;
  onExplain: (selection: ExplainSelection) => void;
}) {
  const hasExplainableCells = event.rows.some((row) => event.columns.some((column) =>
    isExplainableTraceCell(row[column.key], column),
  ));
  return (
    <figure className={styles.traceTableFigure}>
      <div className={styles.traceArtifactHeader}>
        <figcaption>
          <span>TABLE</span>
          <strong>{event.caption}</strong>
        </figcaption>
        <button
          type="button"
          onClick={() => onExplain({ title: event.caption, provenance: event.provenance })}
        >
          Sources
        </button>
      </div>
      <div className={styles.traceTableScroll}>
        <table>
          <thead>
            <tr>
              {event.columns.map((column) => <th key={column.key}>{column.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {event.rows.length ? event.rows.map((row, rowIndex) => (
              <tr key={`${event.resultId}-${rowIndex}`}>
                {event.columns.map((column) => {
                  const rawValue = row[column.key];
                  const value = formatTraceCell(rawValue, column, event.rowFormats?.[rowIndex]);
                  const explainable = isExplainableTraceCell(rawValue, column);
                  return (
                    <td key={column.key} data-numeric={explainable || undefined}>
                      {explainable ? (
                        <button
                          type="button"
                          title={`Explain ${column.label}: ${value}`}
                          aria-label={`Explain ${column.label}, ${value}`}
                          onClick={() => onExplain({
                            title: `${column.label} · ${String(row[event.columns[0].key] ?? `row ${rowIndex + 1}`)}`,
                            value,
                            provenance: event.provenance,
                          })}
                        >
                          {value}<span aria-hidden="true">↗</span>
                        </button>
                      ) : value}
                    </td>
                  );
                })}
              </tr>
            )) : (
              <tr className={styles.traceTableEmpty}>
                <td colSpan={Math.max(event.columns.length, 1)}>No rows matched this governed query.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasExplainableCells ? (
        <p className={styles.traceTableFootnote}>Select any number to inspect its source, definition, freshness, and immutable receipt.</p>
      ) : null}
    </figure>
  );
}

export function ResultChart({ event, table }: { event: TraceChartEvent; table?: TraceTableEvent }) {
  const theme = useSyncExternalStore(subscribeToThemePreference, getThemePreference, getServerThemePreference);
  const appearance = theme === "dark"
    || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
  const descriptionId = useId().replaceAll(":", "");
  const [view, setView] = useState<"chart" | "table">("chart");
  const plan = useMemo(() => table ? groundedFlintPlanForChart(event, table) : null, [event, table]);
  const minimumPoints = event.chartType === "line" ? 3 : 2;
  const hasChart = Boolean(table && plan && plan.data.length >= minimumPoints);
  const tableCaption = table?.caption?.trim() ?? "";
  const exploratory = /^Exploratory(?:\s*·\s*|$)/iu.test(tableCaption);
  const dateRangeLabel = formatChartDateRange(table?.provenance.timeRange);
  const showTable = view === "table" && Boolean(table);
  const categoryCount = plan
    ? new Set(plan.data.map((row) => String(row[event.xKey] ?? ""))).size
    : 0;
  const horizontal = Boolean(
    plan
    && plan.chart_spec.chartType !== "Line Chart"
    && plan.chart_spec.encodings.y
    && "field" in plan.chart_spec.encodings.y
    && plan.chart_spec.encodings.y.field === event.xKey,
  );
  const chartHeight = horizontal
    ? Math.max(280, Math.min(620, categoryCount * 34 + 96))
    : 400;

  if (!table) return null;

  return (
    <figure className={styles.traceChartFigure}>
      <div className={styles.traceArtifactHeader}>
        <figcaption>
          <strong>{event.caption}</strong>
        </figcaption>
        {exploratory || dateRangeLabel || table ? (
          <div className={styles.traceChartMeta}>
            {exploratory ? (
              <span className={styles.traceChartPill}>Exploratory</span>
            ) : null}
            {dateRangeLabel ? (
              <span className={styles.traceChartPill} title={dateRangeLabel}>
                {dateRangeLabel}
              </span>
            ) : null}
            {table ? (
              <button
                className={styles.traceChartViewToggle}
                type="button"
                aria-pressed={showTable}
                aria-label={showTable ? "Show the chart" : "Show the table behind this chart"}
                title={showTable ? "Show the chart" : "Show the table behind this chart"}
                onClick={() => setView((current) => (current === "chart" ? "table" : "chart"))}
              >
                {showTable ? <ChartViewIcon /> : <ChartTableIcon />}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {showTable && table ? (
        <GovernedResultGrid table={table} ariaLabel="Chart data" />
      ) : hasChart && plan ? (
        <div className={styles.traceChartScroll} aria-label="Chart">
          <div className={styles.traceChartCanvas}>
            <p className="sr-only" id={descriptionId}>
              {event.caption}. {plan.data.length} points as a {plan.chart_spec.chartType}. Exact values are available in the governed source table.
            </p>
            <FlintChartView
              plan={plan}
              appearance={appearance}
              title={event.caption}
              height={chartHeight}
            />
          </div>
        </div>
      ) : (
        <p className={styles.traceChartUnavailable}>
          At least {minimumPoints} chartable values are required; the exact result remains available in the governed source table.
        </p>
      )}
    </figure>
  );
}

export default function AnalyticalTrace({
  events,
  streaming = false,
  runtime = "openai",
  lineageReference,
  onFollowUp,
  onClarification,
}: AnalyticalTraceProps) {
  const [explainSelection, setExplainSelection] = useState<ExplainSelection | null>(null);
  const [lineageAttempt, setLineageAttempt] = useState(0);
  const [lineageState, setLineageState] = useState<LineageState>({ kind: "loading", key: "" });
  const explainTitleId = useId().replaceAll(":", "");
  const lineageCacheRef = useRef<Readonly<{ key: string; lineage: SafeAnswerLineage }> | null>(null);
  const explainPanelRef = useRef<HTMLElement>(null);
  const explainPreviousFocusRef = useRef<HTMLElement | null>(null);
  const orderedEvents = useMemo(
    () => [...events].sort((first, second) => first.sequence - second.sequence),
    [events],
  );
  const presentedResultIds = useMemo(() => {
    return responseVisibleResultIds(orderedEvents);
  }, [orderedEvents]);
  const tables = useMemo(
    () => new Map(
      orderedEvents.flatMap((event) => event.type === "table" ? [[event.resultId, event] as const] : []),
    ),
    [orderedEvents],
  );
  const auditProvenance = useMemo(() => {
    for (let index = orderedEvents.length - 1; index >= 0; index -= 1) {
      const event = orderedEvents[index];
      if (event.type === "answer" || event.type === "table") return event.provenance;
    }
    return undefined;
  }, [orderedEvents]);
  const lineageConversationId = lineageReference?.conversationId;
  const lineageTurnId = lineageReference?.turnId;
  const lineageKey = lineageConversationId && lineageTurnId
    ? `${lineageConversationId}:${lineageTurnId}`
    : "";
  const visibleLineageState: LineageState = streaming
    ? {
        kind: "idle",
        message: "Albert seals the immutable receipt after this turn finishes.",
      }
    : !lineageConversationId || !lineageTurnId
      ? {
          kind: "idle",
          message: runtime === "fixture"
            ? "Local fixture turns do not create production answer artifacts."
            : "This message does not retain the turn identifiers needed to load its sealed receipt.",
        }
      : lineageState.kind !== "idle" && lineageState.key === lineageKey
        ? lineageState
        : { kind: "loading", key: lineageKey };

  const openExplanation = (selection: ExplainSelection) => {
    if (!explainSelection) {
      explainPreviousFocusRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    }
    setExplainSelection(selection);
  };

  const explanationOpen = explainSelection !== null;
  useEffect(() => {
    if (!explanationOpen) return;
    const focusFrame = window.requestAnimationFrame(() => {
      explainPanelRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setExplainSelection(null);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", closeOnEscape);
      const previousFocus = explainPreviousFocusRef.current;
      explainPreviousFocusRef.current = null;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [explanationOpen]);

  useEffect(() => {
    if (!explainSelection || streaming || !lineageConversationId || !lineageTurnId) return;

    const controller = new AbortController();
    void (async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      if (lineageCacheRef.current?.key === lineageKey) {
        setLineageState({ kind: "ready", key: lineageKey, lineage: lineageCacheRef.current.lineage });
        return;
      }
      setLineageState({ kind: "loading", key: lineageKey });
      try {
        const response = await fetch(
          `/api/conversations/${encodeURIComponent(lineageConversationId)}/turns/${encodeURIComponent(lineageTurnId)}/lineage`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = await response.json().catch(() => null) as {
          lineage?: unknown;
          error?: string;
        } | null;
        if (!response.ok) throw new Error(payload?.error || "The immutable answer record could not be loaded.");
        const lineage = parseSafeAnswerLineage(payload?.lineage, {
          conversationId: lineageConversationId,
          turnId: lineageTurnId,
        });
        if (!lineage) throw new Error("The immutable answer record returned invalid metadata.");
        lineageCacheRef.current = { key: lineageKey, lineage };
        setLineageState({ kind: "ready", key: lineageKey, lineage });
      } catch (error) {
        if (controller.signal.aborted) return;
        setLineageState({
          kind: "error",
          key: lineageKey,
          message: error instanceof Error ? error.message : "The immutable answer record could not be loaded.",
        });
      }
    })();
    return () => controller.abort();
  }, [explainSelection, lineageAttempt, lineageConversationId, lineageKey, lineageTurnId, streaming]);

  return (
    <section className={styles.analyticalTrace} aria-label="Albert execution narrative">
      <header className={styles.traceHeader}>
        <div>
          <span className={`${styles.traceLiveDot} ${streaming ? styles.traceLiveDotActive : ""}`} aria-hidden="true" />
          <div>
            <h3>{streaming ? "Albert is working" : "How Albert reached this answer"}</h3>
            <p>A concise record of planning, data work, and validation.</p>
          </div>
        </div>
        <div className={styles.traceHeaderMeta}>
          <span>{runtime === "fixture"
            ? "Demo dataset"
            : runtime === "anthropic"
              ? "Claude Opus 5 runtime"
              : "OpenAI runtime"}</span>
          {auditProvenance ? (
            <button
              type="button"
              onClick={() => openExplanation({ title: "Immutable turn record", provenance: auditProvenance })}
            >
              Audit record
            </button>
          ) : null}
          <span className={styles.traceEventCount}>{orderedEvents.length} {orderedEvents.length === 1 ? "step" : "steps"}</span>
        </div>
      </header>

      <div className={styles.traceEventList} aria-live={streaming ? "polite" : "off"}>
        {orderedEvents.map((event) => (
          <article
            className={styles.traceEvent}
            data-event-type={event.type}
            data-status={event.status}
            key={event.id}
          >
            <div className={styles.traceRail} aria-hidden="true">
              <span><TraceGlyph type={event.type} /></span>
            </div>
            <div className={styles.traceEventBody}>
              {event.type === "progress" ? (
                <div className={styles.traceProgress}>
                  <div>
                    <strong>{event.label}</strong>
                    {event.progress !== undefined ? <span>{Math.round(event.progress * 100)}%</span> : null}
                  </div>
                  <div
                    role="progressbar"
                    aria-label={event.label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(event.progress === undefined
                      ? { "aria-valuetext": "In progress" }
                      : { "aria-valuenow": Math.round(event.progress * 100) })}
                  >
                    <span
                      aria-hidden="true"
                      style={{ width: event.progress === undefined ? "36%" : `${event.progress * 100}%` }}
                    />
                  </div>
                </div>
              ) : null}

              {event.type === "narrative" ? <p className={styles.traceNarrative}>{event.text}</p> : null}

              {event.type === "query" ? (
                <div className={styles.traceQueryPlan}>
                  <span>ANALYSIS PLAN</span>
                  <h4>{event.topic}</h4>
                  <p>{event.lens}</p>
                  <div>
                    {[...event.metrics, ...event.dimensions].map((item) => <small key={item}>{item}</small>)}
                  </div>
                  <time dateTime={event.timeRange.start}>{event.timeRange.label} · {event.timeRange.timezone}</time>
                </div>
              ) : null}

              {event.type === "table" && (!presentedResultIds || presentedResultIds.has(event.resultId))
                ? <ResultTable event={event} onExplain={openExplanation} />
                : null}

              {event.type === "chart" && tables.get(event.dataRef) ? (
                <ResultChart event={event} table={tables.get(event.dataRef)} />
              ) : null}

              {event.type === "validation" && event.outcome !== "passed" ? (
                <div className={styles.traceValidation} data-outcome={event.outcome}>
                  <span aria-hidden="true">{event.outcome === "qualified" ? "!" : "×"}</span>
                  <div><strong>{event.name}</strong><p>{event.detail}</p></div>
                </div>
              ) : null}

              {event.type === "answer" ? (
                <div className={styles.traceAnswer} data-answer-state={event.state}>
                  <div className={styles.traceAnswerTopline}>
                    <span title={answerStateDescriptions[event.state]}>{event.state}</span>
                    <button type="button" onClick={() => openExplanation({ title: "Final answer", provenance: event.provenance })}>Explain answer</button>
                  </div>
                  <p>{event.text}</p>
                  {event.followUps.length ? (
                    <div className={styles.traceFollowUps} aria-label="Suggested follow-up questions">
                      {event.followUps.map((followUp) => (
                        <button key={followUp} type="button" disabled={!onFollowUp} onClick={() => onFollowUp?.(followUp)}>
                          {followUp}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {event.type === "clarification" ? (
                <div className={styles.traceClarification}>
                  <span>ONE DETAIL NEEDED</span>
                  <h4>{event.question}</h4>
                  <div role="group" aria-label={event.question}>
                    {event.options.map((option) => <button key={option.id} type="button" disabled={!onClarification} onClick={() => onClarification?.(option.label, option.id)}>{option.label}</button>)}
                  </div>
                </div>
              ) : null}

              {event.type === "error" ? (
                <div className={styles.traceError} role="alert">
                  <strong>Chat failed</strong>
                  <p>{event.message}</p>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {explainSelection ? (
        <ProvenancePanel
          selection={explainSelection}
          lineageState={visibleLineageState}
          onRetryLineage={() => setLineageAttempt((attempt) => attempt + 1)}
          onClose={() => setExplainSelection(null)}
          panelRef={explainPanelRef}
          titleId={`${explainTitleId}-explanation-title`}
        />
      ) : null}
    </section>
  );
}
