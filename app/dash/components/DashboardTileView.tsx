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
import { defaultPivot, type DashboardTableStyle } from "@/packages/shared/src/dashboard-pivot";
import { composedPivotSource } from "../lib/dashboard-pivot-view";
import { PivotTableView } from "./PivotTableView";
import {
  getThemeAppearance,
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
  return useSyncExternalStore(
    subscribeToThemePreference,
    getThemeAppearance,
    () => "light",
  );
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

export function TileChart({ data, display, title, presentation }: Readonly<{
  data: TileData;
  display: TileChartDisplay;
  title: string;
  presentation?: TileColumnPresentation;
}>) {
  const appearance = useChartAppearance();
  const plan = useMemo(() => {
    const columns = data.columns.map(column => {
      const style = presentation?.[column.key];
      return { ...column, label: style?.label ?? column.label, type: style?.format === "text" ? "string" as const : style?.format ?? column.type };
    });
    const xColumn = resolveDashboardColumn(columns, display.xKey);
    const yColumn = resolveDashboardColumn(columns, display.yKey);
    if (!xColumn || !yColumn) return null;
    const series = (display.series ?? []).flatMap((entry) => {
      const column = resolveDashboardColumn(columns, entry.key);
      return column ? [{ key: column.key, label: presentation?.[column.key]?.label ?? entry.label }] : [];
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
        ...(series.length > 1 ? { measureLabel: yColumn.type === "currency" ? `Amount (${yColumn.currency ?? "AUD"})` : yColumn.type === "percent" ? "Percentage" : "Value" } : {}),
        columns,
        valueDecimals: Object.fromEntries(Object.entries(presentation ?? {}).flatMap(([key, style]) => style.decimals === undefined ? [] : [[key, style.decimals]])),
        rows: data.rows as readonly Readonly<Record<string, TraceCell>>[],
      });
    } catch {
      return null;
    }
  }, [data, display, title, presentation]);
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
  tableStyle,
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
  tableStyle?: DashboardTableStyle;
}>) {
  if (data.rows.length === 0) return <TileEmpty>No data for the governed period.</TileEmpty>;
  if (data.pivot) {
    const source = composedPivotSource(data, data.rowFormats);
    return <PivotTableView source={source} config={defaultPivot(source)} tableStyle={tableStyle} title={ariaLabel ?? "Pivot table"} />;
  }
  const rows = maxRows ? data.rows.slice(0, maxRows) : data.rows;
  const totalRows = data.totalRowCount ?? data.rows.length;
  const rowNumbers = tableStyle?.rowNumbers === true;
  return (
    <div className={styles.tableFrame} data-density={tableStyle?.rowHeight ?? "small"} data-banded={tableStyle?.bandedRows || undefined} data-vertical-grid={tableStyle?.verticalGrid ?? true} data-preset={tableStyle?.preset ?? "spreadsheet"}>
    <div className={styles.tableScroll} tabIndex={0} aria-label={ariaLabel ?? "Scrollable governed table"}>
      <table className={styles.table}>
        <thead>
          <tr>
            {rowNumbers ? <th className={styles.rowNumber} aria-label="Row number" /> : null}
            {data.columns.map((column) => (
              <th
                key={column.key}
                data-numeric={NUMERIC_COLUMN_TYPES.has(column.type)}
                data-selected={selectedColumnKey === column.key ? "true" : undefined}
              >
                {headerCell ? headerCell(column) : <span className={styles.plainHeader}><span>{presentation?.[column.key]?.label ?? column.label}</span><span className={styles.headerChevron}>⌄</span></span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            return (
              <tr key={rowIndex}>
                {rowNumbers ? <th scope="row" className={styles.rowNumber}>{rowIndex + 1}</th> : null}
                {data.columns.map((column) => {
                  const value = row[column.key];
                  const item = presentation?.[column.key];
                  const text = formatDashboardCell(value, column, item);
                  const numeric = NUMERIC_COLUMN_TYPES.has(item?.format === "text" ? "string" : (item?.format ?? column.type));
                  return (
                    <td
                      key={column.key}
                      data-numeric={numeric}
                      data-selected={selectedColumnKey === column.key ? "true" : undefined}
                      onClick={onSelectColumn ? () => onSelectColumn(column.key) : undefined}
                      onContextMenu={onCellContextMenu
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
    </div>
    <div className={styles.tableFooter} role="status"><span>{totalRows > rows.length ? `Showing ${rows.length} of ${totalRows.toLocaleString("en-AU")} rows` : `${totalRows.toLocaleString("en-AU")} rows`}</span><span>{data.columns.length} columns</span></div>
    </div>
  );
}

export const tileStyles = styles;
