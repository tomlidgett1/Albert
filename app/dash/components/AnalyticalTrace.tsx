"use client";

import { ResponsiveBar, type BarDatum, type BarTooltipProps } from "@nivo/bar";
import { ResponsiveLine, type LineSeries, type PointTooltipProps } from "@nivo/line";
import { useReducedMotion } from "framer-motion";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  axisToNivo,
  barDesignToNivoProps,
  legendToNivo,
  lineDesignToNivoProps,
  type TraceChartEvent,
  type TraceEvent,
  type TraceProvenance,
  type TraceTableEvent,
} from "@/packages/shared/src";
import { responseVisibleResultIds } from "../lib/answer-presentation";
import { usePublishedNivoChartDesign } from "../lib/nivo-chart-design-store";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES } from "./connectors";
import styles from "../dash.module.css";
import {
  parseSafeAnswerLineage,
  type SafeAnswerLineage,
  type TurnLineageReference,
} from "./answer-lineage";
import {
  formatChartDateLabel,
  formatCompactTraceCell,
  formatTraceCell,
  isExplainableTraceCell,
  traceCellNumber,
} from "./analytical-values";
import ChartDebugSettings, { useNivoChartDebugConfig } from "./ChartDebugSettings";
import {
  createBarChartDebugConfig,
  createLineChartDebugConfig,
} from "./chart-debug-config";
import { computeLineChartLayout } from "./line-chart-layout";

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
  Verified: "Checked against your connected data",
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

function formatChartDateRange(range: Readonly<{ start: string; end: string; label: string }> | undefined) {
  if (!range) return "";
  const start = range.start.trim();
  const end = range.end.trim();
  if (start && end) {
    const startLabel = formatChartDate(start);
    const endLabel = formatChartDate(end);
    return startLabel === endLabel ? startLabel : `${startLabel} – ${endLabel}`;
  }
  return range.label.trim();
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
                  const value = formatTraceCell(rawValue, column);
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

const NIVO_CHART_COLOURS: string[] = [
  "var(--dash-chart-1)",
  "var(--dash-chart-2)",
  "var(--dash-chart-3)",
  "var(--dash-chart-4)",
];

type PreparedChartRow = Readonly<{
  /** Axis / index key. Pre-formatted so Nivo never truncates raw ISO ticks. */
  x: string;
  source: TraceTableEvent["rows"][number];
}>;

function chartAxisLabel(
  raw: TraceTableEvent["rows"][number][string],
  xKey: string,
  xColumn: TraceTableEvent["columns"][number] | undefined,
): string {
  const dateLabel = formatChartDateLabel(raw, xKey);
  if (dateLabel) return dateLabel;
  if (xColumn) return formatTraceCell(raw, xColumn);
  return String(raw ?? "");
}

export function ResultChart({ event, table }: { event: TraceChartEvent; table?: TraceTableEvent }) {
  const reducedMotion = useReducedMotion();
  const publishedDesign = usePublishedNivoChartDesign();
  const descriptionId = useId().replaceAll(":", "");
  const xColumn = table?.columns.find((column) => column.key === event.xKey);
  const primaryColumn = table?.columns.find((column) => column.key === event.yKey);
  const series = useMemo(() => {
    if (!table) return [];
    const requested = event.series?.length
      ? event.series
      : [{ key: event.yKey, label: primaryColumn?.label ?? event.yKey.replaceAll("_", " ") }];
    return requested.flatMap((item) => {
      const column = table.columns.find((candidate) => candidate.key === item.key);
      return column ? [{ ...item, column }] : [];
    });
  }, [event.series, event.yKey, primaryColumn?.label, table]);
  const rows = useMemo<PreparedChartRow[]>(() => {
    if (!table || !series.length) return [];
    const usedLabels = new Map<string, number>();
    return table.rows.flatMap((row) => {
      const rawX = row[event.xKey];
      if (rawX === null || rawX === undefined) return [];
      const hasValue = series.some(({ key }) => traceCellNumber(row[key]) !== null);
      if (!hasValue) return [];
      // Format before the chart sees the value. Nivo's truncateTickAt cuts the
      // raw tick string *before* axis format runs, which turned ISO dates into
      // "2026-06-01T00:00:0..." and bypassed date formatting.
      let label = chartAxisLabel(rawX, event.xKey, xColumn);
      const seen = usedLabels.get(label) ?? 0;
      usedLabels.set(label, seen + 1);
      if (seen > 0) label = `${label} (${seen + 1})`;
      return [{ x: label, source: row }];
    });
  }, [event.xKey, series, table, xColumn]);

  const rawRows = useMemo(() => new Map(rows.map((row) => [row.x, row.source])), [rows]);
  const seriesByKey = useMemo(() => new Map(series.map((item) => [item.key, item])), [series]);
  const seriesKeyByLabel = useMemo(() => new Map(series.map((item) => [item.label, item.key])), [series]);
  const formatX = (value: string | number) => {
    const key = String(value);
    // Rows already carry display labels; still re-format if a raw ISO leaks in.
    const raw = rawRows.get(key)?.[event.xKey];
    if (raw !== undefined && raw !== null) {
      return chartAxisLabel(raw, event.xKey, xColumn);
    }
    return formatChartDateLabel(key, event.xKey) ?? key;
  };
  const formatY = (value: number) => primaryColumn
    ? formatCompactTraceCell(value, primaryColumn)
    : new Intl.NumberFormat("en-AU", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const xAxisLegend = xColumn?.label ?? event.xKey.replaceAll("_", " ");
  const yAxisLegend = primaryColumn?.label ?? event.yKey.replaceAll("_", " ");
  const longestXLabel = rows.reduce((longest, row) => Math.max(longest, formatX(row.x).length), 0);
  const yTickLabels = rows.flatMap((row) => series.flatMap((item) => {
    const value = traceCellNumber(row.source[item.key]);
    return value === null ? [] : [formatY(value)];
  }));
  // Nivo positions axis titles and legends inside their respective margins.
  // Size those margins from the real display strings so currency prefixes and
  // business metric names never collide with ticks or the SVG boundary.
  const lineLayout = computeLineChartLayout({
    yTickLabels,
    seriesLabels: series.map((item) => item.label),
  });
  const horizontalBars = event.chartType === "bar" && (
    event.orientation === "horizontal"
    || (event.orientation !== "vertical" && (rows.length >= 8 || longestXLabel > 14))
  );
  const hasLegend = series.length > 1;
  const defaultChartHeight = event.chartType === "line"
    ? publishedDesign.line.height
    : horizontalBars
      ? Math.max(280, Math.min(620, rows.length * 34 + (hasLegend ? 108 : 72)))
      : publishedDesign.bar.height;
  const lineDebugDefaults = useMemo(() => createLineChartDebugConfig({
    height: defaultChartHeight,
    margin: {
      top: 50,
      right: lineLayout.rightMargin,
      bottom: lineLayout.bottomMargin,
      left: lineLayout.leftMargin,
    },
    yAxisLegendOffset: lineLayout.yAxisLegendOffset,
    legendTranslateX: lineLayout.legendTranslateX,
    legendTranslateY: lineLayout.legendTranslateY,
    legendItemWidth: lineLayout.legendItemWidth,
  }), [
    defaultChartHeight,
    lineLayout.bottomMargin,
    lineLayout.legendItemWidth,
    lineLayout.legendTranslateX,
    lineLayout.legendTranslateY,
    lineLayout.leftMargin,
    lineLayout.rightMargin,
    lineLayout.yAxisLegendOffset,
  ]);
  const barDebugDefaults = useMemo(() => createBarChartDebugConfig({
    height: defaultChartHeight,
    horizontal: horizontalBars,
    hasLegend,
    longestXLabel,
    rowCount: rows.length,
  }), [defaultChartHeight, hasLegend, horizontalBars, longestXLabel, rows.length]);
  const chartDebugDefaults = useMemo(() => event.chartType === "line"
    ? lineDebugDefaults
    : barDebugDefaults, [barDebugDefaults, event.chartType, lineDebugDefaults]);
  const chartDebug = useNivoChartDebugConfig(chartDebugDefaults);
  const lineConfig = chartDebug.config.chartType === "line" ? chartDebug.config : lineDebugDefaults;
  const barConfig = chartDebug.config.chartType === "bar" ? chartDebug.config : barDebugDefaults;
  const publishedBar = publishedDesign.bar;
  const publishedLine = publishedDesign.line;
  const barUsesManualLayout = publishedBar.layoutMode === "manual" || chartDebug.hasOverride;
  const lineUsesManualLayout = publishedLine.layoutMode === "manual" || chartDebug.hasOverride;
  const barIsHorizontal = (barUsesManualLayout ? (chartDebug.hasOverride ? barConfig.layout : publishedBar.layout) : (horizontalBars ? "horizontal" : "vertical")) === "horizontal";
  const chartHeight = event.chartType === "line"
    ? (lineUsesManualLayout ? (chartDebug.hasOverride ? lineConfig.height : publishedLine.height) : defaultChartHeight)
    : (barUsesManualLayout ? (chartDebug.hasOverride ? barConfig.height : publishedBar.height) : defaultChartHeight);
  const barMargin = barUsesManualLayout
    ? (chartDebug.hasOverride ? barConfig.margin : publishedBar.margin)
    : barDebugDefaults.margin;
  const lineMargin = lineUsesManualLayout
    ? (chartDebug.hasOverride ? lineConfig.margin : publishedLine.margin)
    : lineDebugDefaults.margin;
  const maxXTicks = chartDebug.hasOverride ? lineConfig.maxXTicks : publishedLine.maxXTicks;
  const publishedBarProps = barDesignToNivoProps(publishedDesign);
  const publishedLineProps = lineDesignToNivoProps(publishedDesign);
  const rawValue = (x: string | number, key: string) => rawRows.get(String(x))?.[key] ?? null;
  const lineTickValues = useMemo(() => {
    if (rows.length <= maxXTicks) return rows.map(({ x }) => x);
    const interval = Math.ceil(rows.length / maxXTicks);
    const sampled = rows.flatMap(({ x }, index) => index % interval === 0
      ? [{ x, index }]
      : []);
    const lastIndex = rows.length - 1;
    const last = rows[lastIndex]!;
    const previous = sampled.at(-1);
    if (!previous || previous.index !== lastIndex) {
      if (previous && lastIndex - previous.index <= Math.ceil(interval / 2)) {
        sampled[sampled.length - 1] = { x: last.x, index: lastIndex };
      } else {
        sampled.push({ x: last.x, index: lastIndex });
      }
    }
    return sampled.map(({ x }) => x);
  }, [maxXTicks, rows]);

  const BarTooltip = ({ id, indexValue, color }: BarTooltipProps<BarDatum>) => {
    const key = String(id);
    const item = seriesByKey.get(key);
    const value = rawValue(indexValue, key);
    return (
      <div className={styles.traceChartTooltip}>
        <span><i style={{ backgroundColor: color }} />{formatX(indexValue)}</span>
        <strong>{item?.label ?? key}: {item ? formatTraceCell(value, item.column) : String(value ?? "—")}</strong>
      </div>
    );
  };

  const LineTooltip = ({ point }: PointTooltipProps<LineSeries>) => {
    const label = String(point.seriesId);
    const key = seriesKeyByLabel.get(label) ?? label;
    const item = seriesByKey.get(key);
    const value = rawValue(String(point.data.x), key);
    return (
      <div className={styles.traceChartTooltip}>
        <span><i style={{ backgroundColor: point.seriesColor }} />{formatX(String(point.data.x))}</span>
        <strong>{item?.label ?? label}: {item ? formatTraceCell(value, item.column) : String(value ?? "—")}</strong>
      </div>
    );
  };

  const barData = useMemo<BarDatum[]>(() => rows.map((row) => ({
    __albert_x: row.x,
    ...Object.fromEntries(series.flatMap(({ key }) => {
      const value = traceCellNumber(row.source[key]);
      return value === null ? [] : [[key, value]];
    })),
  })), [rows, series]);
  const lineData = useMemo<LineSeries[]>(() => series.map((item) => ({
    id: item.label,
    data: rows.map((row) => ({
      x: row.x,
      y: traceCellNumber(row.source[item.key]),
    })),
  })), [rows, series]);

  const barLegend = chartDebug.hasOverride
    ? (barConfig.legend.enabled ? [{
      ...legendToNivo(publishedBar.legend, "keys"),
      anchor: barConfig.legend.anchor,
      direction: barConfig.legend.direction,
      translateX: barConfig.legend.translateX,
      translateY: barConfig.legend.translateY,
      itemWidth: barConfig.legend.itemWidth,
      itemHeight: barConfig.legend.itemHeight,
      itemsSpacing: barConfig.legend.itemsSpacing,
      symbolSize: barConfig.legend.symbolSize,
    }] : [])
    : (publishedBar.legend.enabled ? [legendToNivo(publishedBar.legend, "keys")] : []);
  const lineLegend = chartDebug.hasOverride
    ? (lineConfig.legend.enabled ? [{
      ...legendToNivo(publishedLine.legend),
      anchor: lineConfig.legend.anchor,
      direction: lineConfig.legend.direction,
      translateX: lineConfig.legend.translateX,
      translateY: lineConfig.legend.translateY,
      itemWidth: lineConfig.legend.itemWidth,
      itemHeight: lineConfig.legend.itemHeight,
      itemsSpacing: lineConfig.legend.itemsSpacing,
      symbolSize: lineConfig.legend.symbolSize,
    }] : [])
    : (publishedLine.legend.enabled ? [legendToNivo(publishedLine.legend)] : []);
  const minimumPoints = event.chartType === "line" ? 2 : 1;
  const hasChart = Boolean(table && rows.length >= minimumPoints && series.length && primaryColumn);
  const tableCaption = table?.caption?.trim() ?? "";
  const exploratory = /^Exploratory(?:\s*·\s*|$)/iu.test(tableCaption);
  const dateRangeLabel = formatChartDateRange(table?.provenance.timeRange);

  return (
    <figure className={styles.traceChartFigure}>
      <div className={styles.traceArtifactHeader}>
        <figcaption>
          <strong>{event.caption}</strong>
        </figcaption>
        {exploratory || dateRangeLabel || chartDebug.enabled ? (
          <div className={styles.traceChartMeta}>
            {exploratory ? (
              <span className={styles.traceChartPill}>Exploratory</span>
            ) : null}
            {dateRangeLabel ? (
              <span className={styles.traceChartPill} title={dateRangeLabel}>
                {dateRangeLabel}
              </span>
            ) : null}
            {chartDebug.enabled ? (
              <ChartDebugSettings
                config={chartDebug.config}
                onChange={chartDebug.update}
                onReset={chartDebug.reset}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {hasChart ? (
        <div className={styles.traceChartScroll} aria-label="Responsive chart area">
          <div
            className={styles.traceChartCanvas}
            style={{ height: chartHeight }}
          >
            <p className="sr-only" id={descriptionId}>
              {event.caption}. {rows.length} points across {series.length} {series.length === 1 ? "series" : "series"}. Exact values are available in the governed source table.
            </p>
            {event.chartType === "bar" ? (
              <ResponsiveBar
                {...(publishedBarProps as object)}
                data={barData}
                keys={series.map(({ key }) => key)}
                indexBy="__albert_x"
                layout={barIsHorizontal ? "horizontal" : "vertical"}
                groupMode={chartDebug.hasOverride ? barConfig.groupMode : publishedBar.groupMode}
                margin={barMargin}
                padding={chartDebug.hasOverride ? barConfig.padding : publishedBar.padding}
                innerPadding={chartDebug.hasOverride ? barConfig.innerPadding : publishedBar.innerPadding}
                colors={publishedBarProps.colors ?? NIVO_CHART_COLOURS}
                borderRadius={chartDebug.hasOverride ? barConfig.borderRadius : publishedBar.borderRadius}
                borderWidth={chartDebug.hasOverride ? barConfig.borderWidth : publishedBar.borderWidth}
                enableGridX={chartDebug.hasOverride ? barConfig.enableGridX : publishedBar.enableGridX}
                enableGridY={chartDebug.hasOverride ? barConfig.enableGridY : publishedBar.enableGridY}
                enableLabel={chartDebug.hasOverride ? barConfig.enableLabel : publishedBar.enableLabel}
                label={(datum) => formatY(datum.value ?? 0)}
                labelSkipWidth={chartDebug.hasOverride ? barConfig.labelSkipWidth : publishedBar.labelSkipWidth}
                labelSkipHeight={chartDebug.hasOverride ? barConfig.labelSkipHeight : publishedBar.labelSkipHeight}
                axisTop={axisToNivo(publishedBar.axisTop, barIsHorizontal ? yAxisLegend : xAxisLegend)}
                axisRight={axisToNivo(publishedBar.axisRight, barIsHorizontal ? xAxisLegend : yAxisLegend)}
                axisBottom={axisToNivo(
                  chartDebug.hasOverride
                    ? { ...publishedBar.axisBottom, ...barConfig.axisBottom, enabled: publishedBar.axisBottom.enabled }
                    : publishedBar.axisBottom,
                  barIsHorizontal ? yAxisLegend : xAxisLegend,
                  barIsHorizontal ? (value) => formatY(Number(value)) : formatX,
                )}
                axisLeft={axisToNivo(
                  chartDebug.hasOverride
                    ? { ...publishedBar.axisLeft, ...barConfig.axisLeft, enabled: publishedBar.axisLeft.enabled }
                    : publishedBar.axisLeft,
                  barIsHorizontal ? xAxisLegend : yAxisLegend,
                  barIsHorizontal ? formatX : (value) => formatY(Number(value)),
                )}
                legends={barLegend}
                legendLabel={(datum) => seriesByKey.get(String(datum.id))?.label ?? String(datum.id)}
                tooltip={BarTooltip}
                ariaLabel={event.caption}
                ariaDescribedBy={descriptionId}
                barAriaLabel={(datum) => `${seriesByKey.get(String(datum.id))?.label ?? String(datum.id)}, ${formatY(datum.value ?? 0)}, ${formatX(datum.indexValue)}`}
                animate={!reducedMotion && publishedBar.animate}
                animateOnMount={!reducedMotion && publishedBar.animateOnMount}
              />
            ) : (
              <ResponsiveLine
                {...(publishedLineProps as object)}
                data={lineData}
                margin={lineMargin}
                xScale={{ type: "point" }}
                yScale={{
                  type: publishedLine.yScale.type,
                  min: chartDebug.hasOverride ? lineConfig.yScale.min : publishedLine.yScale.min,
                  max: publishedLine.yScale.max,
                  stacked: chartDebug.hasOverride ? lineConfig.yScale.stacked : publishedLine.yScale.stacked,
                  reverse: chartDebug.hasOverride ? lineConfig.yScale.reverse : publishedLine.yScale.reverse,
                }}
                curve={chartDebug.hasOverride ? lineConfig.curve : publishedLine.curve}
                colors={publishedLineProps.colors ?? NIVO_CHART_COLOURS}
                lineWidth={chartDebug.hasOverride ? lineConfig.lineWidth : publishedLine.lineWidth}
                enableArea={chartDebug.hasOverride ? lineConfig.enableArea : publishedLine.enableArea}
                enableGridX={chartDebug.hasOverride ? lineConfig.enableGridX : publishedLine.enableGridX}
                enableGridY={chartDebug.hasOverride ? lineConfig.enableGridY : publishedLine.enableGridY}
                enablePoints={chartDebug.hasOverride ? lineConfig.enablePoints : publishedLine.enablePoints}
                pointSize={chartDebug.hasOverride ? lineConfig.pointSize : publishedLine.pointSize}
                pointBorderWidth={chartDebug.hasOverride ? lineConfig.pointBorderWidth : publishedLine.pointBorderWidth}
                areaOpacity={chartDebug.hasOverride ? lineConfig.areaOpacity : publishedLine.areaOpacity}
                enableTouchCrosshair={chartDebug.hasOverride ? lineConfig.enableTouchCrosshair : publishedLine.enableTouchCrosshair}
                useMesh={chartDebug.hasOverride ? lineConfig.useMesh : publishedLine.useMesh}
                axisTop={axisToNivo(publishedLine.axisTop, xAxisLegend)}
                axisRight={axisToNivo(publishedLine.axisRight, yAxisLegend)}
                axisBottom={axisToNivo(
                  chartDebug.hasOverride
                    ? { ...publishedLine.axisBottom, ...lineConfig.axisBottom, enabled: publishedLine.axisBottom.enabled }
                    : publishedLine.axisBottom,
                  xAxisLegend,
                  formatX,
                  lineTickValues,
                )}
                axisLeft={axisToNivo(
                  chartDebug.hasOverride
                    ? { ...publishedLine.axisLeft, ...lineConfig.axisLeft, enabled: publishedLine.axisLeft.enabled }
                    : publishedLine.axisLeft,
                  yAxisLegend,
                  (value) => formatY(Number(value)),
                )}
                legends={lineLegend}
                tooltip={LineTooltip}
                ariaLabel={event.caption}
                ariaDescribedBy={descriptionId}
                pointAriaLabel={(point) => `${String(point.seriesId)}, ${formatX(String(point.data.x))}, ${formatY(Number(point.data.y))}`}
                animate={!reducedMotion && publishedLine.animate}
              />
            )}
          </div>
        </div>
      ) : (
        <p className={styles.traceChartUnavailable}>
          {table ? `At least ${minimumPoints} chartable ${minimumPoints === 1 ? "value is" : "values are"} required; the exact result remains available in the governed source table.` : "The governed source table is not available in this trace."}
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

              {event.type === "chart" ? <ResultChart event={event} table={tables.get(event.dataRef)} /> : null}

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
                          <svg className={styles.traceFollowUpIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path
                              d="M5.5 3.5h7v7M12.5 3.5 3.5 12.5"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                          <span>{followUp}</span>
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
