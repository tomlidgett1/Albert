"use client";

import { useMemo, useState } from "react";
import type {
  TraceChartEvent,
  TraceEvent,
  TraceProvenance,
  TraceTableColumn,
  TraceTableEvent,
} from "@/packages/shared/src";
import styles from "../dash.module.css";

type AnalyticalTraceProps = {
  events: readonly TraceEvent[];
  streaming?: boolean;
  runtime?: "fixture" | "openai";
  onFollowUp?: (prompt: string) => void;
  onClarification?: (value: string) => void;
};

type ExplainSelection = {
  title: string;
  value?: string;
  provenance: TraceProvenance;
};

const answerStateDescriptions = {
  Verified: "Validated against complete, query-ready data",
  Qualified: "Useful with a disclosed data or definition limitation",
  Exploratory: "Directional analysis that should be verified before action",
  Clarification: "Albert needs one answer before the analysis can continue",
  Unavailable: "The required data is not currently queryable",
} as const;

function formatCell(value: string | number | null, column: TraceTableColumn) {
  if (value === null) return "—";
  if (typeof value !== "number") return value;

  if (column.type === "currency") {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      maximumFractionDigits: 0,
    }).format(value);
  }

  if (column.type === "percent") {
    const normalized = Math.abs(value) <= 1 ? value : value / 100;
    return new Intl.NumberFormat("en-AU", {
      style: "percent",
      maximumFractionDigits: 1,
      signDisplay: "exceptZero",
    }).format(normalized);
  }

  return new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(value);
}

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
  onClose,
}: {
  selection: ExplainSelection;
  onClose: () => void;
}) {
  const { provenance } = selection;

  return (
    <aside className={styles.traceExplainPanel} aria-labelledby="trace-explain-title">
      <div className={styles.traceExplainHeader}>
        <div>
          <p>EXPLAIN THIS NUMBER</p>
          <h4 id="trace-explain-title">{selection.title}</h4>
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
          <small>Version used for this answer</small>
        </div>
      </dl>

      <div className={styles.traceExplainSection}>
        <h5>Sources and freshness</h5>
        <ul>
          {provenance.sources.map((source) => (
            <li key={`${source.connector}-${source.label}`}>
              <span className={styles.traceSourceMark} data-source={source.connector} aria-hidden="true" />
              <div>
                <strong>{source.label}</strong>
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
            {event.rows.map((row, rowIndex) => (
              <tr key={`${event.resultId}-${rowIndex}`}>
                {event.columns.map((column) => {
                  const rawValue = row[column.key];
                  const value = formatCell(rawValue, column);
                  const explainable = typeof rawValue === "number";
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
            ))}
          </tbody>
        </table>
      </div>
      <p className={styles.traceTableFootnote}>Select any number to inspect its source, definition, and freshness.</p>
    </figure>
  );
}

function ResultChart({ event, table }: { event: TraceChartEvent; table?: TraceTableEvent }) {
  const points = useMemo(() => {
    if (!table) return [];
    return table.rows.flatMap((row) => {
      const value = row[event.yKey];
      const label = row[event.xKey];
      return typeof value === "number" && label !== null
        ? [{ label: String(label), value }]
        : [];
    });
  }, [event.xKey, event.yKey, table]);

  const width = 620;
  const height = 236;
  const padding = { top: 18, right: 18, bottom: 42, left: 24 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const slotWidth = points.length ? chartWidth / points.length : chartWidth;
  const linePoints = points.map((point, index) => ({
    ...point,
    x: padding.left + slotWidth * index + slotWidth / 2,
    y: padding.top + chartHeight - (point.value / maxValue) * chartHeight,
  }));
  const linePath = linePoints.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");

  return (
    <figure className={styles.traceChartFigure}>
      <div className={styles.traceArtifactHeader}>
        <figcaption>
          <span>{event.chartType.toUpperCase()} CHART</span>
          <strong>{event.caption}</strong>
        </figcaption>
        <small>From {table?.caption ?? event.dataRef}</small>
      </div>
      {points.length ? (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={event.caption}>
          <line className={styles.traceChartBaseline} x1={padding.left} x2={width - padding.right} y1={padding.top + chartHeight} y2={padding.top + chartHeight} />
          {event.chartType === "bar" ? points.map((point, index) => {
            const barWidth = Math.min(58, slotWidth * 0.54);
            const barHeight = (point.value / maxValue) * chartHeight;
            const x = padding.left + slotWidth * index + (slotWidth - barWidth) / 2;
            const y = padding.top + chartHeight - barHeight;
            return (
              <g key={`${point.label}-${index}`}>
                <rect className={styles.traceChartBar} x={x} y={y} width={barWidth} height={barHeight} rx="6" />
                <text className={styles.traceChartValue} x={x + barWidth / 2} y={Math.max(12, y - 7)} textAnchor="middle">{new Intl.NumberFormat("en-AU", { notation: "compact" }).format(point.value)}</text>
                <text className={styles.traceChartLabel} x={x + barWidth / 2} y={height - 14} textAnchor="middle">{point.label}</text>
              </g>
            );
          }) : (
            <>
              <path className={styles.traceChartLine} d={linePath} />
              {linePoints.map((point, index) => (
                <g key={`${point.label}-${index}`}>
                  <circle className={styles.traceChartDot} cx={point.x} cy={point.y} r="4" />
                  <text className={styles.traceChartValue} x={point.x} y={Math.max(12, point.y - 9)} textAnchor="middle">{new Intl.NumberFormat("en-AU", { notation: "compact" }).format(point.value)}</text>
                  <text className={styles.traceChartLabel} x={point.x} y={height - 14} textAnchor="middle">{point.label}</text>
                </g>
              ))}
            </>
          )}
        </svg>
      ) : (
        <p className={styles.traceChartUnavailable}>The governed source table is not available in this trace.</p>
      )}
    </figure>
  );
}

export default function AnalyticalTrace({
  events,
  streaming = false,
  runtime = "fixture",
  onFollowUp,
  onClarification,
}: AnalyticalTraceProps) {
  const [explainSelection, setExplainSelection] = useState<ExplainSelection | null>(null);
  const orderedEvents = useMemo(
    () => [...events].sort((first, second) => first.sequence - second.sequence),
    [events],
  );
  const tables = useMemo(
    () => new Map(
      orderedEvents.flatMap((event) => event.type === "table" ? [[event.resultId, event] as const] : []),
    ),
    [orderedEvents],
  );

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
          <span>{runtime === "fixture" ? "Demo dataset" : "OpenAI runtime"}</span>
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
                  <div aria-hidden="true"><span style={{ width: event.progress === undefined ? "36%" : `${event.progress * 100}%` }} /></div>
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

              {event.type === "table" ? <ResultTable event={event} onExplain={setExplainSelection} /> : null}

              {event.type === "chart" ? <ResultChart event={event} table={tables.get(event.dataRef)} /> : null}

              {event.type === "validation" ? (
                <div className={styles.traceValidation} data-outcome={event.outcome}>
                  <span aria-hidden="true">{event.outcome === "passed" ? "✓" : event.outcome === "qualified" ? "!" : "×"}</span>
                  <div><strong>{event.name}</strong><p>{event.detail}</p></div>
                </div>
              ) : null}

              {event.type === "answer" ? (
                <div className={styles.traceAnswer} data-answer-state={event.state}>
                  <div className={styles.traceAnswerTopline}>
                    <span title={answerStateDescriptions[event.state]}>{event.state}</span>
                    <button type="button" onClick={() => setExplainSelection({ title: "Final answer", provenance: event.provenance })}>Explain answer</button>
                  </div>
                  <p>{event.text}</p>
                  {event.followUps.length ? (
                    <div className={styles.traceFollowUps} aria-label="Suggested follow-up questions">
                      {event.followUps.map((followUp) => (
                        <button key={followUp} type="button" onClick={() => onFollowUp?.(followUp)}>{followUp}</button>
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
                    {event.options.map((option) => <button key={option.id} type="button" onClick={() => onClarification?.(option.value)}>{option.label}</button>)}
                  </div>
                </div>
              ) : null}

              {event.type === "error" ? (
                <div className={styles.traceError} role="alert">
                  <strong>{event.recoverable ? "Albert can retry this step" : "Analysis stopped"}</strong>
                  <p>{event.message}</p>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>

      {explainSelection ? <ProvenancePanel selection={explainSelection} onClose={() => setExplainSelection(null)} /> : null}
    </section>
  );
}
