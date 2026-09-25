"use client";

/**
 * Pure view-model helpers for dashboard mode: turn a build turn's live trace
 * events (and the applied document) into preview tiles the build panel
 * renders, plus the dashboard-flavoured thinking states the chat trail shows
 * while the architect works ("Determining the best elements", "Creating
 * element: Revenue trend").
 */

import type {
  TraceCell,
  TraceDashboardPlanEvent,
  TraceEvent,
  TraceRowFormat,
  TraceTableColumn,
  TraceTableEvent,
} from "@/packages/shared/src";
import {
  firstNumericDashboardColumn,
  resolveDashboardColumn,
} from "../components/dashboard-values";

export type PreviewTileKind = "kpi" | "chart" | "table";

export type PreviewTile = Readonly<{
  key: string;
  kind: PreviewTileKind;
  title: string;
  note?: string;
  /** Column span on the panel's 12-column grid. */
  span: number;
  /** Row span on the workspace grid's 28px rows — the applied tile's height. */
  heightRows: number;
  /** A composed pivot (metrics as rows, periods as columns). */
  pivot?: boolean;
  /** Per-row formats a pivot carries (mixed units down the rows). */
  rowFormats?: readonly (TraceRowFormat | null)[];
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  valueKey?: string;
  chartType?: "bar" | "line";
  xKey?: string;
  yKey?: string;
  series?: readonly Readonly<{ key: string; label: string }>[];
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
  /** Draft tiles stream in while the architect is still designing. */
  drafting?: boolean;
}>;

export type DashboardBuildView = Readonly<{
  /** True once this turn is recognisably a dashboard build. */
  isBuildTurn: boolean;
  /** The composed plan, once ComposeDashboard has been accepted. */
  plan: TraceDashboardPlanEvent | null;
  tiles: readonly PreviewTile[];
  /** A query that is running but has not returned its table yet. */
  pendingQueryName: string | null;
  queryCount: number;
  activity: string;
  answered: boolean;
  failed: string | null;
}>;

const WIDTH_SPANS: Readonly<Record<string, number>> = Object.freeze({
  quarter: 3,
  third: 4,
  half: 6,
  twoThirds: 8,
  full: 12,
});

const NUMERIC_TYPES = new Set(["number", "currency", "percent"]);

/** Tile heights on the workspace grid (28px rows), matching the apply packer. */
export const TILE_ROWS: Readonly<Record<PreviewTileKind, number>> = Object.freeze({
  kpi: 5,
  chart: 9,
  table: 7,
});

function isPivotTable(table: TraceTableEvent): boolean {
  return table.dashboardReplay?.kind === "derived_v1" || Boolean(table.rowFormats);
}

/** Dashboard-flavoured wording for the analyst's progress labels. */
export function dashboardActivityLabel(event: TraceEvent): string | null {
  if (event.type === "tasks") return "Planning the dashboard";
  if (event.type === "research") {
    return event.tool === "value_lookup" ? "Checking real values" : "Determining the best elements";
  }
  if (event.type === "query") {
    return event.name ? `Creating element: ${event.name}` : "Creating an element";
  }
  if (event.type === "dashboard_plan") return "Composing the dashboard";
  if (event.type === "progress" && event.status === "running") {
    const label = event.label;
    const query = /^Running query: (.+)$/u.exec(label);
    if (query) return `Creating element: ${query[1]}`;
    const failed = /^Query failed: (.+)$/u.exec(label);
    if (failed) return `Reworking element: ${failed[1]}`;
    if (/^Reading the semantic model/u.test(label)) return "Reading your data model";
    if (/^Looking up /u.test(label)) return "Checking real values";
    if (/^Writing the answer/u.test(label)) return "Composing the dashboard";
    return label;
  }
  return null;
}

/**
 * True when a turn's events identify it as a dashboard-architect turn.
 *
 * Only the composed plan marks a build. A table's `dashboardReplay` is the
 * pinning reference every governed table carries (that is what the "+ Add to
 * dashboard" action replays), so it says nothing about the turn's intent —
 * treating it as a build marker put ordinary Omni answers into dashboard
 * chrome ("Composing the dashboard", the preview toggle, dashboard mode on
 * reopen). A build that is still streaming is identified by the message's
 * own `dashboardBuild` flag, set when it was sent.
 */
export function isDashboardBuildTurn(events: readonly TraceEvent[]): boolean {
  return events.some((event) => event.type === "dashboard_plan");
}

function draftKind(table: TraceTableEvent): PreviewTileKind {
  // A composed pivot (metrics as rows) is a table by construction.
  if (isPivotTable(table)) return "table";
  const numeric = firstNumericDashboardColumn(table.columns);
  if (!numeric) return "table";
  const nonNumeric = table.columns.filter((column) => !NUMERIC_TYPES.has(column.type));
  const compareOnly = nonNumeric.every((column) => column.key === "compareDateRange");
  if (table.rows.length <= 2 && compareOnly) return "kpi";
  if (table.rows.length >= 2) return "chart";
  return "table";
}

function draftDisplay(table: TraceTableEvent, kind: PreviewTileKind): Partial<PreviewTile> {
  if (kind === "kpi") {
    return { valueKey: firstNumericDashboardColumn(table.columns)?.key };
  }
  if (kind === "chart") {
    const numeric = firstNumericDashboardColumn(table.columns);
    const xColumn = table.columns.find((column) => !NUMERIC_TYPES.has(column.type) && column.key !== "compareDateRange")
      ?? table.columns[0];
    if (!numeric || !xColumn || xColumn.key === numeric.key) return {};
    const timeAxis = xColumn.type === "date" || xColumn.type === "datetime";
    return {
      chartType: timeAxis ? "line" : "bar",
      xKey: xColumn.key,
      yKey: numeric.key,
    };
  }
  return {};
}

/**
 * The panel's live view of one build turn. Before the plan lands, every
 * governed result streams in as a draft tile; the composed plan replaces the
 * drafts with the real layout, titles, and presentations.
 */
export function buildDashboardBuildView(
  events: readonly TraceEvent[],
  streaming: boolean,
  /** The turn was sent as a dashboard build (known before its plan lands). */
  buildTurn = false,
): DashboardBuildView {
  const tablesByResultId = new Map<string, TraceTableEvent>();
  let plan: TraceDashboardPlanEvent | null = null;
  let queryCount = 0;
  let lastQueryName: string | null = null;
  let lastQueryResolved = true;
  let activity = "Reading your data model";
  let answered = false;
  let failed: string | null = null;

  for (const event of events) {
    const label = dashboardActivityLabel(event);
    if (label) activity = label;
    if (event.type === "query") {
      queryCount += 1;
      lastQueryName = event.name ?? event.topic;
      lastQueryResolved = false;
    } else if (event.type === "table") {
      tablesByResultId.set(event.resultId, event);
      lastQueryResolved = true;
    } else if (event.type === "dashboard_plan") {
      plan = event;
    } else if (event.type === "answer") {
      answered = true;
    } else if (event.type === "error") {
      failed = event.message;
    }
  }

  const tiles: PreviewTile[] = [];
  if (plan) {
    for (const tile of plan.tiles) {
      const table = tablesByResultId.get(tile.resultId);
      if (!table) continue;
      tiles.push({
        key: `plan-${tile.resultId}`,
        kind: tile.kind,
        title: tile.title,
        ...(tile.note ? { note: tile.note } : {}),
        span: WIDTH_SPANS[tile.width] ?? 6,
        heightRows: TILE_ROWS[tile.kind],
        ...(isPivotTable(table) ? { pivot: true } : {}),
        ...(table.rowFormats ? { rowFormats: table.rowFormats } : {}),
        columns: table.columns,
        rows: table.rows,
        ...(tile.valueKey ? { valueKey: tile.valueKey } : {}),
        ...(tile.chartType ? { chartType: tile.chartType } : {}),
        ...(tile.xKey ? { xKey: tile.xKey } : {}),
        ...(tile.yKey ? { yKey: tile.yKey } : {}),
        ...(tile.series?.length ? { series: tile.series } : {}),
        ...(tile.stacked === undefined ? {} : { stacked: tile.stacked }),
        ...(tile.orientation ? { orientation: tile.orientation } : {}),
      });
    }
  } else {
    for (const [resultId, table] of tablesByResultId) {
      if (table.dashboardReplay === undefined) continue;
      if (table.rows.length === 0) continue;
      const kind = draftKind(table);
      const pivot = isPivotTable(table);
      tiles.push({
        key: `draft-${resultId}`,
        kind,
        title: table.caption,
        span: kind === "kpi" ? 3 : pivot ? 12 : 6,
        heightRows: TILE_ROWS[kind],
        ...(pivot ? { pivot: true } : {}),
        ...(table.rowFormats ? { rowFormats: table.rowFormats } : {}),
        columns: table.columns,
        rows: table.rows,
        drafting: true,
        ...draftDisplay(table, kind),
      });
    }
  }

  return Object.freeze({
    isBuildTurn: buildTurn || isDashboardBuildTurn(events),
    plan,
    tiles,
    pendingQueryName: streaming && !lastQueryResolved ? lastQueryName : null,
    queryCount,
    activity,
    answered,
    failed,
  });
}

/** Resolve a preview tile's chart columns tolerantly (dot vs underscore keys). */
export function previewChartConfig(tile: PreviewTile): Readonly<{
  chartType: "bar" | "line";
  xKey: string;
  yKey: string;
  series?: readonly Readonly<{ key: string; label: string }>[];
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
}> | null {
  if (tile.kind !== "chart" || !tile.chartType) return null;
  const xColumn = resolveDashboardColumn(tile.columns, tile.xKey);
  const yColumn = resolveDashboardColumn(tile.columns, tile.yKey);
  if (!xColumn || !yColumn) return null;
  const series = (tile.series ?? []).flatMap((entry) => {
    const column = resolveDashboardColumn(tile.columns, entry.key);
    return column ? [{ key: column.key, label: entry.label }] : [];
  });
  return {
    chartType: tile.chartType,
    xKey: xColumn.key,
    yKey: yColumn.key,
    ...(series.length > 0 ? { series } : {}),
    ...(tile.stacked === undefined ? {} : { stacked: tile.stacked }),
    ...(tile.orientation ? { orientation: tile.orientation } : {}),
  };
}
