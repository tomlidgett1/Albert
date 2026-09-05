"use client";

/**
 * The shared dashboard tile bodies. Both the live build preview and the
 * applied, editable dashboard render through these, so a tile looks the
 * same from the moment its query lands to the moment it is saved — no
 * design swap when the plan applies. The visual language follows Sigma's
 * defaults: a KPI chart with the value dominant and a directional
 * comparison beneath it; tables in the Spreadsheet preset; pivots with a
 * shaded, frozen row-header column.
 */

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import dynamic from "next/dynamic";
import {
  compileGroundedFlint,
  type TraceCell,
  type TraceRowFormat,
  type TraceTableColumn,
} from "@/packages/shared/src";
import type { DashboardColumnPresentationItem } from "@/services/control-plane/src/dashboard-repository";
import {
  getServerThemePreference,
  getThemePreference,
  subscribeToThemePreference,
} from "@/app/theme-preference";
import {
  type KpiBetterWhen,
  type KpiComparison,
  computeKpiPresentation,
  formatDashboardCell,
  resolveDashboardColumn,
} from "./dashboard-values";
import styles from "./dashboard-tile.module.css";

const FlintChartView = dynamic(() => import("./FlintChartView"), { ssr: false });

const NUMERIC_COLUMN_TYPES = new Set(["number", "currency", "percent"]);

export type TileColumnPresentation = Readonly<Record<string, DashboardColumnPresentationItem>>;

/** The governed result a tile presents, from a trace table or a snapshot. */
export type TileData = Readonly<{
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, unknown>>[];
  totalRowCount?: number;
  /** Per-row formats (pivoted results carry mixed units down the rows). */
  rowFormats?: readonly (TraceRowFormat | null)[];
  /** A composed pivot: metrics as rows, periods as columns. */
  pivot?: boolean;
}>;

export type TileChartDisplay = Readonly<{
  chartType: "bar" | "line";
  xKey: string;
  yKey: string;
  series?: readonly Readonly<{ key: string; label: string }>[];
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
}>;

export function useChartAppearance(): "light" | "dark" {
  const theme = useSyncExternalStore(
    subscribeToThemePreference,
    getThemePreference,
    getServerThemePreference,
  );
  return theme === "dark"
    || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
}

export function TileEmpty({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.empty}>{children}</div>;
}

/**
 * KPI: the headline value, then the period-on-period comparison as a
 * directional arrow, the signed change, and a caption naming the basis.
 */
export function TileKpi({ data, valueKey, presentation, note, comparison, betterWhen }: Readonly<{
  data: TileData;
  valueKey?: string | undefined;
  presentation?: TileColumnPresentation | undefined;
  note?: string | undefined;
  /** Sigma's KPI comparison display and which direction is good (ADR 0134). */
  comparison?: KpiComparison | undefined;
  betterWhen?: KpiBetterWhen | undefined;
}>) {
  const column = resolveDashboardColumn(data.columns, valueKey);
  const kpi = useMemo(() => computeKpiPresentation({
    columns: data.columns,
    rows: data.rows,
    valueKey,
    presentation: column ? presentation?.[column.key] : undefined,
    comparison,
    betterWhen,
  }), [betterWhen, column, comparison, data.columns, data.rows, presentation, valueKey]);
  if (data.rows.length === 0) return <TileEmpty>No data for the governed period.</TileEmpty>;
  if (!kpi) return <TileEmpty>This result has no numeric value to feature.</TileEmpty>;
  const caption = note ?? (kpi.magnitude !== null ? "vs prior period" : undefined);
  return (
    <div className={styles.kpi}>
      <span className={styles.kpiValue}>{kpi.value}</span>
      {kpi.magnitude !== null || caption ? (
        <span className={styles.kpiCompare} data-direction={kpi.magnitude !== null ? kpi.direction : undefined} data-tone={kpi.magnitude !== null ? kpi.tone : undefined}>
          {kpi.magnitude !== null ? (
            <span className={styles.kpiDelta}>
              <span className={styles.kpiArrow} aria-hidden="true">
                {kpi.direction === "up" ? "▲" : kpi.direction === "down" ? "▼" : "•"}
              </span>
              <span className={styles.srOnly}>{kpi.direction === "up" ? "Up" : kpi.direction === "down" ? "Down" : "Flat"}</span>
              {kpi.magnitude}
            </span>
          ) : null}
          {caption ? <span className={styles.kpiCaption}>{caption}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

export function TileChart({ data, display, title }: Readonly<{
  data: TileData;
  display: TileChartDisplay;
  title: string;
}>) {
  const appearance = useChartAppearance();
  const plan = useMemo(() => {
    const xColumn = resolveDashboardColumn(data.columns, display.xKey);
    const yColumn = resolveDashboardColumn(data.columns, display.yKey);
    if (!xColumn || !yColumn) return null;
    const series = (display.series ?? []).flatMap((entry) => {
      const column = resolveDashboardColumn(data.columns, entry.key);
      return column ? [{ key: column.key, label: entry.label }] : [];
    });
    try {
      return compileGroundedFlint({
        caption: title,
        chartType: display.chartType,
        ...(display.stacked === undefined ? {} : { stacked: display.stacked }),
        ...(display.orientation ? { orientation: display.orientation } : {}),
        xKey: xColumn.key,
        yKey: yColumn.key,
        ...(series.length > 0 ? { series } : {}),
        columns: data.columns,
        rows: data.rows as readonly Readonly<Record<string, TraceCell>>[],
      });
    } catch {
      return null;
    }
  }, [data, display, title]);
  if (data.rows.length === 0) return <TileEmpty>No data for the governed period.</TileEmpty>;
  if (!plan) return <TileEmpty>This result no longer fits its chart. Switch the tile to table view.</TileEmpty>;
  return (
    <div className={styles.chart}>
      {/* Fill mode sizes the drawing to the tile box, so resizing the tile
          resizes the chart instead of clipping its axis or legend. */}
      <FlintChartView plan={plan} appearance={appearance} title={title} fill />
    </div>
  );
}

function isTotalRow(row: Readonly<Record<string, unknown>>, firstKey: string | undefined): boolean {
  if (!firstKey) return false;
  const label = row[firstKey];
  return typeof label === "string" && /^(grand )?total$/iu.test(label.trim());
}

/**
 * Table in the Spreadsheet preset. `headerCell` lets the editable workspace
 * table swap its rename/select controls into the header cells while the
 * grid itself stays identical everywhere.
 */
export function TileTable({
  data,
  presentation,
  maxRows,
  selectedColumnKey,
  onSelectColumn,
  onCellContextMenu,
  headerCell,
  ariaLabel,
}: Readonly<{
  data: TileData;
  presentation?: TileColumnPresentation | undefined;
  maxRows?: number | undefined;
  selectedColumnKey?: string | null | undefined;
  onSelectColumn?: ((key: string) => void) | undefined;
  /** Right-click on a value: Sigma's "Keep only" / "Exclude" entry point. */
  onCellContextMenu?: ((column: TraceTableColumn, value: unknown, event: React.MouseEvent<HTMLTableCellElement>) => void) | undefined;
  headerCell?: ((column: TraceTableColumn) => ReactNode) | undefined;
  ariaLabel?: string | undefined;
}>) {
  if (data.rows.length === 0) return <TileEmpty>No data for the governed period.</TileEmpty>;
  const rows = maxRows ? data.rows.slice(0, maxRows) : data.rows;
  const totalRows = data.totalRowCount ?? data.rows.length;
  const firstKey = data.columns[0]?.key;
  const pivot = data.pivot === true;
  return (
    <div className={styles.tableScroll} tabIndex={0} aria-label={ariaLabel ?? "Scrollable governed table"}>
      <table className={styles.table} data-pivot={pivot ? "true" : undefined}>
        <thead>
          <tr>
            {data.columns.map((column, index) => (
              <th
                key={column.key}
                data-numeric={!pivot || index > 0 ? NUMERIC_COLUMN_TYPES.has(column.type) : undefined}
                data-selected={selectedColumnKey === column.key ? "true" : undefined}
              >
                {headerCell ? headerCell(column) : (presentation?.[column.key]?.label ?? column.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const rowFormat = data.rowFormats?.[rowIndex] ?? undefined;
            return (
              <tr key={rowIndex} data-total={pivot && isTotalRow(row, firstKey) ? "true" : undefined}>
                {data.columns.map((column, index) => {
                  const value = row[column.key];
                  const item = presentation?.[column.key];
                  // Pivot value cells take the row's unit; everything else
                  // formats by column, honouring the owner's presentation.
                  // Always the dashboard formatter, so "$6,240.00" matches
                  // the KPI cards rather than the trace's "AUD 6,240.00".
                  const cellColumn = pivot && index > 0 && rowFormat
                    ? { ...column, type: rowFormat.type, ...(rowFormat.currency ? { currency: rowFormat.currency } : {}) }
                    : column;
                  const text = formatDashboardCell(value, cellColumn, item);
                  const numeric = pivot && index > 0
                    ? true
                    : NUMERIC_COLUMN_TYPES.has(item?.format === "text" ? "string" : (item?.format ?? column.type));
                  return (
                    <td
                      key={column.key}
                      data-numeric={numeric}
                      data-selected={selectedColumnKey === column.key ? "true" : undefined}
                      onClick={onSelectColumn ? () => onSelectColumn(column.key) : undefined}
                      onContextMenu={onCellContextMenu && !pivot
                        ? (event) => onCellContextMenu(column, value, event)
                        : undefined}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {totalRows > rows.length ? (
        <div className={styles.rowCount}>Showing {rows.length} of {totalRows.toLocaleString("en-AU")} rows</div>
      ) : null}
    </div>
  );
}

export const tileStyles = styles;
