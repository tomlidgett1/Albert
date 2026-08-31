import { z } from "zod";

import type {
  DashboardLayouts,
  DashboardTile,
  DashboardTileDisplay,
} from "../../control-plane/src/dashboard-repository.js";

/** One architect turn designs, executes and composes the whole dashboard. */
export const DASHBOARD_BUILD_MODEL = "gpt-5.6-luna" as const;
export const DASHBOARD_BUILD_EFFORT = "max" as const;
/** Quality over latency: fast mode stays off for builds, like Dashboard Master. */
export const DASHBOARD_BUILD_FAST_MODE = false as const;

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

export const dashboardBuildRequestSchema = z.object({
  instruction: z.string().trim().min(4).max(2_000),
}).strict();

export const dashboardBuildApplyRequestSchema = z.object({
  conversationId: ulidSchema,
  turnId: ulidSchema,
}).strict();

/**
 * Revalidation of a persisted `dashboard_plan` trace event. The runtime's
 * compose tool validated the plan against executed evidence before emitting
 * it, and the append gate sanitised it; this schema is the web's own belt
 * when reading it back.
 */
export const dashboardPlanTileSchema = z.object({
  resultId: ulidSchema,
  kind: z.enum(["kpi", "chart", "table"]),
  title: z.string().trim().min(1).max(120),
  note: z.string().max(160).optional(),
  width: z.enum(["quarter", "third", "half", "twoThirds", "full"]),
  valueKey: z.string().max(160).optional(),
  chartType: z.enum(["bar", "line"]).optional(),
  xKey: z.string().max(160).optional(),
  yKey: z.string().max(160).optional(),
  series: z.array(z.object({
    key: z.string().min(1).max(160),
    label: z.string().min(1).max(160),
  }).strict()).max(6).optional(),
  stacked: z.boolean().optional(),
  orientation: z.enum(["vertical", "horizontal"]).optional(),
}).strict();

export const dashboardPlanEventSchema = z.object({
  type: z.literal("dashboard_plan"),
  id: z.string().min(1),
  dashboardTitle: z.string().trim().min(1).max(80),
  timeframe: z.string().trim().min(1).max(120),
  tiles: z.array(dashboardPlanTileSchema).min(1).max(12),
}).passthrough();

export type DashboardPlanTile = z.infer<typeof dashboardPlanTileSchema>;
export type DashboardPlanEvent = z.infer<typeof dashboardPlanEventSchema>;

/** The tile presentation a plan tile resolves to. */
export function displayFromPlanTile(tile: DashboardPlanTile): DashboardTileDisplay {
  if (tile.kind === "kpi") {
    return {
      mode: "kpi",
      ...(tile.valueKey ? { valueKey: tile.valueKey } : {}),
      ...(tile.note ? { note: tile.note } : {}),
    };
  }
  if (tile.kind === "chart" && tile.chartType && tile.xKey && tile.yKey) {
    return {
      mode: "chart",
      chartType: tile.chartType,
      xKey: tile.xKey,
      yKey: tile.yKey,
      ...(tile.series?.length ? { series: tile.series } : {}),
      ...(tile.stacked === undefined ? {} : { stacked: tile.stacked }),
      ...(tile.orientation ? { orientation: tile.orientation } : {}),
      ...(tile.note ? { note: tile.note } : {}),
    };
  }
  return { mode: "table", ...(tile.note ? { note: tile.note } : {}) };
}

const DESKTOP_COLUMNS = 12;
const TABLET_COLUMNS = 8;
const DESKTOP_WIDTHS: Readonly<Record<DashboardPlanTile["width"], number>> = Object.freeze({
  quarter: 3,
  third: 4,
  half: 6,
  twoThirds: 8,
  full: 12,
});
const TABLET_WIDTHS: Readonly<Record<DashboardPlanTile["width"], number>> = Object.freeze({
  quarter: 4,
  third: 4,
  half: 4,
  twoThirds: 8,
  full: 8,
});
const TILE_HEIGHTS: Readonly<Record<DashboardPlanTile["kind"], number>> = Object.freeze({
  kpi: 5,
  chart: 8,
  table: 7,
});

function packLayout(
  tiles: readonly Readonly<{ tileId: string; kind: DashboardPlanTile["kind"]; width: DashboardPlanTile["width"] }>[],
  columns: number,
  widths: Readonly<Record<DashboardPlanTile["width"], number>>,
): DashboardLayouts["desktop"] {
  const items: { i: string; x: number; y: number; w: number; h: number }[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const tile of tiles) {
    const w = Math.min(widths[tile.width], columns);
    const h = TILE_HEIGHTS[tile.kind];
    if (x + w > columns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    items.push({ i: tile.tileId, x, y, w, h });
    x += w;
    rowHeight = Math.max(rowHeight, h);
    if (x >= columns) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
  }
  return items;
}

/**
 * Deterministic reading-order packer: tiles fill rows left to right in plan
 * order, each row as tall as its tallest tile. No agent-authored coordinates
 * — determinism is what keeps generated layouts clean.
 */
export function packDashboardLayouts(
  tiles: readonly Readonly<{ tileId: string; kind: DashboardPlanTile["kind"]; width: DashboardPlanTile["width"] }>[],
): DashboardLayouts {
  return {
    desktop: packLayout(tiles, DESKTOP_COLUMNS, DESKTOP_WIDTHS),
    tablet: packLayout(tiles, TABLET_COLUMNS, TABLET_WIDTHS),
  };
}

/**
 * The architect brief. The design system lives in the runtime's dashboard
 * instructions; this message carries only the owner's ask and the current
 * dashboard so a refinement keeps what works.
 */
export function buildDashboardBriefMessage(input: Readonly<{
  instruction: string;
  currentTiles: readonly DashboardTile[];
}>): string {
  const lines = [
    "Design and build my dashboard.",
    "",
    `What I want: ${input.instruction.trim()}`,
  ];
  if (input.currentTiles.length > 0) {
    lines.push(
      "",
      "You are replacing my current dashboard. Its tiles, for context — keep what still serves the request, improve or drop the rest:",
      ...input.currentTiles.slice(0, 24).map((tile) => {
        const mode = tile.display.mode;
        const empty = tile.snapshot?.empty ? ", currently empty" : "";
        return `- "${tile.title}" (${mode}${empty})`;
      }),
    );
  }
  return lines.join("\n").slice(0, 6_000);
}
