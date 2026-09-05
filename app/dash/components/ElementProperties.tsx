"use client";

/**
 * Sigma's element editor for one dashboard element (ADR 0134): two tabs,
 * Properties and Format. Properties holds what the element shows — Show as,
 * the chart or KPI settings, and the governed query's shape (Truncate date,
 * Date range, the column list, Add column, Rows). Format holds how a column
 * reads (format, decimals, name), the KPI comparison and the note.
 *
 * Presentation changes apply instantly. Query-shape changes are one
 * deterministic edit each, run by the server against the governed model
 * (`POST /api/dashboard/tiles/:id/query`); the element keeps its data while
 * the new result loads.
 */

import { useState } from "react";

import type {
  DashboardColumnFormat,
  DashboardColumnPresentation,
  DashboardTile,
  DashboardTileDisplay,
} from "@/services/control-plane/src/dashboard-repository";
import type { DashboardQueryEdit } from "@/services/dashboard/src/query-edits";
import { canonicalColumnKey, publicColumnKey } from "@/packages/albert-v3/src/cube/presentation";
import styles from "./dashboard-workspace.module.css";

/** `GET /api/dashboard/tiles/:id/fields` — the view behind the element and its query's shape. */
export type ElementFields = Readonly<{
  view: Readonly<{
    name: string;
    title: string;
    queryPolicy?: "aggregate_only";
    minimumTimeGranularity?: string;
  }>;
  inQuery: Readonly<{
    measures: readonly string[];
    dimensions: readonly string[];
    timeDimensions: readonly Readonly<{
      dimension: string;
      granularity?: string;
      dateRange?: string | readonly [string, string];
      compareDateRange?: readonly (string | readonly [string, string])[];
    }>[];
    limit?: number;
  }>;
  members: readonly Readonly<{
    name: string;
    kind: "measure" | "dimension";
    title: string;
    shortTitle: string;
    type?: "string" | "number" | "boolean" | "time";
    folder?: string;
    description?: string;
  }>[];
}>;

export type ElementMemberRef = Readonly<{ member: string; role: "measure" | "dimension" }>;

const GRANULARITIES = ["day", "week", "month", "quarter", "year"] as const;
type Granularity = (typeof GRANULARITIES)[number];
const GRANULARITY_LABELS: Readonly<Record<Granularity, string>> = Object.freeze({
  day: "Day", week: "Week", month: "Month", quarter: "Quarter", year: "Year",
});

/** Relative windows Cube understands, spelled the way the editor offers them. */
const DATE_RANGE_PRESETS: readonly Readonly<{ value: string; label: string }>[] = Object.freeze([
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last 7 days", label: "Last 7 days" },
  { value: "last 30 days", label: "Last 30 days" },
  { value: "last 90 days", label: "Last 90 days" },
  { value: "last 12 weeks", label: "Last 12 weeks" },
  { value: "last 12 months", label: "Last 12 months" },
  { value: "this week", label: "This week" },
  { value: "this month", label: "This month" },
  { value: "last month", label: "Last month" },
  { value: "this quarter", label: "This quarter" },
  { value: "last quarter", label: "Last quarter" },
  { value: "this year", label: "This year" },
  { value: "last year", label: "Last year" },
]);

const ROW_LIMITS = [10, 25, 50, 100, 250, 500] as const;

const COLUMN_FORMATS: readonly Readonly<{ value: "auto" | DashboardColumnFormat; label: string }>[] = Object.freeze([
  { value: "auto", label: "Auto" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "text", label: "Text" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date & time" },
]);

const NUMERIC_TYPES = new Set(["number", "currency", "percent"]);

/** The query member a snapshot column came from, by canonical key (dots ≡ underscores, bucket dropped). */
export function memberForColumnKey(fields: ElementFields | null, columnKey: string): ElementMemberRef | null {
  if (!fields) return null;
  const wanted = canonicalColumnKey(columnKey);
  for (const member of fields.inQuery.measures) {
    if (canonicalColumnKey(publicColumnKey(member)) === wanted) return { member, role: "measure" };
  }
  for (const member of fields.inQuery.dimensions) {
    if (canonicalColumnKey(publicColumnKey(member)) === wanted) return { member, role: "dimension" };
  }
  for (const entry of fields.inQuery.timeDimensions) {
    if (canonicalColumnKey(publicColumnKey(entry.dimension)) === wanted) return { member: entry.dimension, role: "dimension" };
  }
  return null;
}

function describeRange(range: string | readonly [string, string] | undefined): string {
  if (!range) return "All time";
  if (typeof range === "string") return DATE_RANGE_PRESETS.find((preset) => preset.value === range)?.label ?? range;
  return `${range[0]} to ${range[1]}`;
}

function withColumnPresentation(
  tile: DashboardTile,
  columnKey: string,
  patch: Readonly<{ label?: string; format?: "auto" | DashboardColumnFormat; decimals?: "auto" | number; hidden?: boolean }>,
): DashboardColumnPresentation {
  const column = tile.snapshot?.columns.find(({ key }) => key === columnKey);
  const next: DashboardColumnPresentation = { ...tile.columnPresentation };
  if (!column) return next;
  const current = tile.columnPresentation[columnKey];
  const label = patch.label !== undefined ? patch.label.trim() : (current?.label ?? column.label);
  const format = patch.format ?? current?.format ?? "auto";
  const decimals = patch.decimals ?? current?.decimals ?? "auto";
  const hidden = patch.hidden ?? current?.hidden ?? false;
  const presentation = {
    ...(label && label !== column.label ? { label } : {}),
    ...(format !== "auto" ? { format } : {}),
    ...(decimals !== "auto" ? { decimals } : {}),
    ...(hidden ? { hidden: true } : {}),
  };
  if (Object.keys(presentation).length) next[columnKey] = presentation;
  else delete next[columnKey];
  return next;
}

const EYE_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.6" /></svg>;
const EYE_OFF_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 6.3A9.7 9.7 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.7M6.6 6.8C4 8.6 2.5 12 2.5 12s3.5 6 9.5 6a9 9 0 0 0 3.5-.7" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>;
const REMOVE_ICON = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;

export function ElementProperties({
  tile,
  busy,
  modes,
  fields,
  fieldsError,
  onShowAs,
  onDisplayChange,
  onPresentationChange,
  onColumnOrderChange,
  onRequery,
}: Readonly<{
  tile: DashboardTile;
  busy: boolean;
  modes: readonly DashboardTileDisplay["mode"][];
  fields: ElementFields | null;
  fieldsError: string | null;
  onShowAs: (mode: DashboardTileDisplay["mode"]) => void;
  onDisplayChange: (display: DashboardTileDisplay) => void;
  onPresentationChange: (presentation: DashboardColumnPresentation) => void;
  onColumnOrderChange: (order: readonly string[]) => void;
  onRequery: (edits: readonly DashboardQueryEdit[]) => void;
}>) {
  const [tab, setTab] = useState<"properties" | "format">("properties");
  const columns = tile.snapshot?.columns ?? [];
  const shownColumns = columns.filter((column) => column.key !== "compareDateRange");
  const [formatKey, setFormatKey] = useState<string>(shownColumns[0]?.key ?? "");
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const governed = tile.replayKind === "cube_v3";
  const display = tile.display;
  const numericColumns = shownColumns.filter((column) => NUMERIC_TYPES.has(column.type));
  const labelOf = (key: string) => tile.columnPresentation[key]?.label ?? columns.find((column) => column.key === key)?.label ?? key;

  // ---- Governed query shape -------------------------------------------------
  const bucketed = fields?.inQuery.timeDimensions.find((entry) => entry.granularity);
  const windowed = fields?.inQuery.timeDimensions.find((entry) => entry.dateRange || entry.compareDateRange) ?? fields?.inQuery.timeDimensions[0];
  const timeMember = bucketed?.dimension
    ?? windowed?.dimension
    ?? fields?.members.find((member) => member.kind === "dimension" && member.type === "time")?.name;
  const minimumGranularity = fields?.view.queryPolicy === "aggregate_only" ? fields.view.minimumTimeGranularity : undefined;
  const granularityAllowed = (granularity: Granularity) => (
    !minimumGranularity || GRANULARITIES.indexOf(granularity) >= GRANULARITIES.indexOf(minimumGranularity as Granularity)
  );
  const currentRange = windowed?.compareDateRange ? "compare" : typeof windowed?.dateRange === "string"
    ? (DATE_RANGE_PRESETS.some((preset) => preset.value === windowed.dateRange) ? windowed.dateRange : "custom")
    : windowed?.dateRange ? "custom" : "";
  const inQuery = new Set([
    ...(fields?.inQuery.measures ?? []),
    ...(fields?.inQuery.dimensions ?? []),
    ...(fields?.inQuery.timeDimensions.map((entry) => entry.dimension) ?? []),
  ]);
  const addable = (fields?.members ?? []).filter((member) => !inQuery.has(member.name));
  const shownMemberCount = (fields?.inQuery.measures.length ?? 0) + (fields?.inQuery.dimensions.length ?? 0)
    + (fields?.inQuery.timeDimensions.filter((entry) => entry.granularity).length ?? 0);

  const moveColumn = (key: string, delta: -1 | 1) => {
    const order = shownColumns.map((column) => column.key);
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    onColumnOrderChange(order);
  };

  const formatColumn = columns.find((column) => column.key === formatKey) ?? shownColumns[0] ?? null;
  const formatPresentation = formatColumn ? tile.columnPresentation[formatColumn.key] : undefined;
  const formatValue = formatPresentation?.format ?? "auto";
  const resolvedFormat = formatValue === "auto" ? formatColumn?.type : formatValue;
  const decimalsApply = resolvedFormat ? NUMERIC_TYPES.has(resolvedFormat) : false;

  return (
    <div className={styles.propertiesPanel} aria-label={`Properties for ${tile.title}`} aria-busy={busy || undefined}>
      <div className={styles.propertiesTabs}>
        <span className={styles.segmented} role="tablist" aria-label="Element editor">
          <button type="button" role="tab" aria-selected={tab === "properties"} onClick={() => setTab("properties")}>Properties</button>
          <button type="button" role="tab" aria-selected={tab === "format"} onClick={() => setTab("format")}>Format</button>
        </span>
      </div>

      {tab === "properties" ? (
        <>
          {modes.length > 1 ? (
            <div className={styles.propSection} role="group" aria-label="Show as">
              <label className={styles.propRow}>
                <span>Show as</span>
                <select aria-label="Show as" value={display.mode} disabled={busy} onChange={(event) => onShowAs(event.target.value as DashboardTileDisplay["mode"])}>
                  {modes.map((mode) => <option key={mode} value={mode}>{mode === "kpi" ? "KPI" : mode === "chart" ? "Chart" : "Table"}</option>)}
                </select>
              </label>
              {display.mode === "chart" ? (
                <>
                  <label className={styles.propRow}>
                    <span>Chart type</span>
                    <select aria-label="Chart type" value={display.chartType} disabled={busy} onChange={(event) => onDisplayChange({ ...display, chartType: event.target.value as "bar" | "line" })}>
                      <option value="bar">Bar</option>
                      <option value="line">Line</option>
                    </select>
                  </label>
                  <label className={styles.propRow}>
                    <span>Orientation</span>
                    <select aria-label="Orientation" value={display.orientation ?? "vertical"} disabled={busy} onChange={(event) => onDisplayChange({ ...display, orientation: event.target.value as "vertical" | "horizontal" })}>
                      <option value="vertical">Vertical</option>
                      <option value="horizontal">Horizontal</option>
                    </select>
                  </label>
                  {(display.series?.length ?? 0) >= 2 ? (
                    <label className={styles.propRow}>
                      <span>Stacking</span>
                      <select aria-label="Stacking" value={display.stacked ? "stacked" : "none"} disabled={busy} onChange={(event) => onDisplayChange({ ...display, stacked: event.target.value === "stacked" })}>
                        <option value="none">None</option>
                        <option value="stacked">Stacked</option>
                      </select>
                    </label>
                  ) : null}
                </>
              ) : null}
              {display.mode === "kpi" && numericColumns.length > 1 ? (
                <label className={styles.propRow}>
                  <span>Value</span>
                  <select aria-label="Value" value={display.valueKey ?? numericColumns[0]!.key} disabled={busy} onChange={(event) => onDisplayChange({ ...display, valueKey: event.target.value })}>
                    {numericColumns.map((column) => <option key={column.key} value={column.key}>{labelOf(column.key)}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}

          {governed ? (
            fields ? (
              <>
                {timeMember ? (
                  <div className={styles.propSection} role="group" aria-label="Date">
                    <label className={styles.propRow}>
                      <span>Truncate date</span>
                      <select
                        aria-label="Truncate date"
                        value={bucketed?.granularity ?? ""}
                        disabled={busy}
                        onChange={(event) => {
                          const granularity = event.target.value as Granularity | "";
                          if (!granularity) return;
                          onRequery([{ op: "set_granularity", dimension: bucketed?.dimension ?? timeMember, granularity }]);
                        }}
                      >
                        {bucketed ? null : <option value="">Not shown</option>}
                        {GRANULARITIES.map((granularity) => (
                          <option key={granularity} value={granularity} disabled={!granularityAllowed(granularity)}>{GRANULARITY_LABELS[granularity]}</option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.propRow}>
                      <span>Date range</span>
                      <select
                        aria-label="Date range"
                        value={currentRange}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "custom" || value === "compare") return;
                          const dimension = windowed?.dimension ?? timeMember;
                          const edits: DashboardQueryEdit[] = [];
                          if (windowed?.compareDateRange) edits.push({ op: "set_compare", dimension, compareDateRange: null });
                          edits.push({ op: "set_date_range", dimension, dateRange: value === "" ? null : value });
                          onRequery(edits);
                        }}
                      >
                        <option value="">All time</option>
                        {DATE_RANGE_PRESETS.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
                        {currentRange === "custom" ? <option value="custom">{describeRange(windowed?.dateRange)}</option> : null}
                        {currentRange === "compare" ? <option value="compare">Comparing periods</option> : null}
                      </select>
                    </label>
                  </div>
                ) : null}

                <div className={styles.propSection} role="group" aria-label="Columns">
                  <span className={styles.menuSectionLabel}>Columns</span>
                  <div className={styles.propColumns}>
                    {shownColumns.map((column, index) => {
                      const hidden = tile.columnPresentation[column.key]?.hidden === true;
                      const member = memberForColumnKey(fields, column.key);
                      return (
                        <div key={column.key} className={styles.propColumn} data-hidden={hidden ? "true" : undefined}>
                          <span>{labelOf(column.key)}</span>
                          <button type="button" aria-label={`Move ${labelOf(column.key)} up`} disabled={busy || index === 0} onClick={() => moveColumn(column.key, -1)}>▲</button>
                          <button type="button" aria-label={`Move ${labelOf(column.key)} down`} disabled={busy || index === shownColumns.length - 1} onClick={() => moveColumn(column.key, 1)}>▼</button>
                          <button
                            type="button"
                            aria-label={hidden ? `Show ${labelOf(column.key)}` : `Hide ${labelOf(column.key)}`}
                            aria-pressed={hidden}
                            disabled={busy}
                            onClick={() => onPresentationChange(withColumnPresentation(tile, column.key, { hidden: !hidden }))}
                          >
                            {hidden ? EYE_OFF_ICON : EYE_ICON}
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${labelOf(column.key)} from the query`}
                            disabled={busy || !member || shownMemberCount <= 1}
                            onClick={() => member && onRequery([member.role === "measure"
                              ? { op: "remove_measure", member: member.member }
                              : { op: "remove_dimension", member: member.member }])}
                          >
                            {REMOVE_ICON}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <label className={styles.propRow}>
                    <span>Add column</span>
                    <select
                      aria-label="Add column"
                      value=""
                      disabled={busy || addable.length === 0}
                      onChange={(event) => {
                        const member = addable.find((candidate) => candidate.name === event.target.value);
                        if (!member) return;
                        onRequery([member.kind === "measure"
                          ? { op: "add_measure", member: member.name }
                          : {
                            op: "add_dimension",
                            member: member.name,
                            ...(member.type === "time" && bucketed?.granularity ? { granularity: bucketed.granularity as Granularity } : {}),
                          }]);
                      }}
                    >
                      <option value="">Choose a field…</option>
                      <optgroup label="Calculations">
                        {addable.filter((member) => member.kind === "measure").map((member) => (
                          <option key={member.name} value={member.name}>{member.shortTitle || member.title}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Columns">
                        {addable.filter((member) => member.kind === "dimension").map((member) => (
                          <option key={member.name} value={member.name}>{member.shortTitle || member.title}</option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                  <label className={styles.propRow}>
                    <span>Rows</span>
                    <select
                      aria-label="Rows"
                      value={fields.inQuery.limit && ROW_LIMITS.includes(fields.inQuery.limit as (typeof ROW_LIMITS)[number]) ? String(fields.inQuery.limit) : ""}
                      disabled={busy}
                      onChange={(event) => {
                        const limit = Number(event.target.value);
                        if (limit > 0) onRequery([{ op: "set_limit", limit }]);
                      }}
                    >
                      {fields.inQuery.limit && !ROW_LIMITS.includes(fields.inQuery.limit as (typeof ROW_LIMITS)[number])
                        ? <option value="">{fields.inQuery.limit}</option>
                        : !fields.inQuery.limit ? <option value="">Default</option> : null}
                      {ROW_LIMITS.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
                    </select>
                  </label>
                </div>
              </>
            ) : (
              <p className={styles.propHint} role={fieldsError ? "alert" : "status"}>{fieldsError ?? "Loading the governed query…"}</p>
            )
          ) : tile.replayKind === "derived_v1" ? (
            <p className={styles.propHint}>Composed by Albert from several queries. Use the wand to change what it shows.</p>
          ) : null}
        </>
      ) : (
        <>
          {formatColumn ? (
            <div className={styles.propSection} role="group" aria-label="Column format">
              <label className={styles.propRow}>
                <span>Column</span>
                <select aria-label="Column" value={formatColumn.key} onChange={(event) => { setFormatKey(event.target.value); setRenameDraft(null); }}>
                  {shownColumns.map((column) => <option key={column.key} value={column.key}>{labelOf(column.key)}</option>)}
                </select>
              </label>
              <label className={styles.propRow}>
                <span>Name</span>
                <input
                  aria-label="Column name"
                  value={renameDraft ?? labelOf(formatColumn.key)}
                  maxLength={160}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => {
                    if (renameDraft === null) return;
                    onPresentationChange(withColumnPresentation(tile, formatColumn.key, { label: renameDraft }));
                    setRenameDraft(null);
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                />
              </label>
              <label className={styles.propRow}>
                <span>Format</span>
                <select
                  aria-label="Value format"
                  value={formatValue}
                  onChange={(event) => {
                    const format = event.target.value as "auto" | DashboardColumnFormat;
                    const resolved = format === "auto" ? formatColumn.type : format;
                    onPresentationChange(withColumnPresentation(tile, formatColumn.key, {
                      format,
                      decimals: NUMERIC_TYPES.has(resolved) ? (formatPresentation?.decimals ?? "auto") : "auto",
                    }));
                  }}
                >
                  {COLUMN_FORMATS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              {decimalsApply ? (
                <label className={styles.propRow}>
                  <span>Decimals</span>
                  <select
                    aria-label="Decimal places"
                    value={formatPresentation?.decimals ?? "auto"}
                    onChange={(event) => onPresentationChange(withColumnPresentation(tile, formatColumn.key, {
                      decimals: event.target.value === "auto" ? "auto" : Number(event.target.value),
                    }))}
                  >
                    <option value="auto">Auto</option>
                    {Array.from({ length: 7 }, (_, decimals) => <option key={decimals} value={decimals}>{decimals}</option>)}
                  </select>
                </label>
              ) : null}
            </div>
          ) : null}
          {display.mode === "kpi" ? (
            <div className={styles.propSection} role="group" aria-label="Comparison">
              <label className={styles.propRow}>
                <span>Comparison</span>
                <select aria-label="Comparison" value={display.comparison ?? "percent_difference"} onChange={(event) => onDisplayChange({ ...display, comparison: event.target.value as NonNullable<typeof display.comparison> })}>
                  <option value="percent_difference">% difference from</option>
                  <option value="difference">Difference from</option>
                  <option value="percent_of">% of</option>
                  <option value="absolute">Absolute</option>
                </select>
              </label>
              <label className={styles.propRow}>
                <span>Better when</span>
                <select aria-label="Better when" value={display.betterWhen ?? "higher"} onChange={(event) => onDisplayChange({ ...display, betterWhen: event.target.value as "higher" | "lower" })}>
                  <option value="higher">Higher</option>
                  <option value="lower">Lower</option>
                </select>
              </label>
            </div>
          ) : null}
          <div className={styles.propSection} role="group" aria-label="Note">
            <label className={styles.propRow}>
              <span>Note</span>
              <input
                aria-label="Note"
                defaultValue={display.note ?? ""}
                maxLength={160}
                placeholder="One line under the title"
                onBlur={(event) => {
                  const note = event.target.value.trim();
                  if ((display.note ?? "") === note) return;
                  const rest = { ...display } as DashboardTileDisplay & { note?: string };
                  delete rest.note;
                  onDisplayChange(note ? { ...rest, note } : rest);
                }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
