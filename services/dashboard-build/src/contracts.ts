import { z } from "zod";

import type {
  DashboardDocument,
  DashboardLayouts,
  DashboardTile,
  DashboardTileDisplay,
} from "../../control-plane/src/dashboard-repository.js";

/** One architect turn designs, executes and composes the whole dashboard. */
export const DASHBOARD_BUILD_MODEL = "gpt-5.6-luna" as const;
export const DASHBOARD_BUILD_EFFORT = "max" as const;
/** Quality over latency: fast mode stays off for builds, like Dashboard Master. */
export const DASHBOARD_BUILD_FAST_MODE = false as const;
/**
 * An element edit (ADR 0134) is one query and one compose over an inlined
 * topic: latency wins, so it runs low effort with fast mode on.
 */
export const DASHBOARD_EDIT_MODEL = "gpt-5.6-luna" as const;
export const DASHBOARD_EDIT_EFFORT = "low" as const;
export const DASHBOARD_EDIT_FAST_MODE = true as const;

/** The Cube view a tile's governed query reads (its first fully qualified member). */
export function queryYamlTopic(queryYaml: string | null | undefined): string | null {
  if (!queryYaml) return null;
  const match = /^\s*-\s+([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*\s*$/mu.exec(queryYaml)
    ?? /dimension:\s*([a-z][a-z0-9_]*)\.[a-z][a-z0-9_]*/u.exec(queryYaml);
  return match?.[1] ?? null;
}

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

export const dashboardBuildRequestSchema = z.object({
  instruction: z.string().trim().min(4).max(2_000),
  /** The dashboard being built; unnamed: the member's most recent one. */
  dashboardId: ulidSchema.optional(),
  /** Set for an element edit (ADR 0134): only this tile is rebuilt. */
  tileId: ulidSchema.optional(),
}).strict();

export const dashboardBuildApplyRequestSchema = z.object({
  conversationId: ulidSchema,
  turnId: ulidSchema,
  dashboardId: ulidSchema.optional(),
  /** An element edit replaces this tile in place instead of the whole dashboard. */
  replaceTileId: ulidSchema.optional(),
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
export type DashboardPlanWidth = DashboardPlanTile["width"];
export type DashboardPlanKind = DashboardPlanTile["kind"];

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
const DESKTOP_WIDTHS: Readonly<Record<DashboardPlanWidth, number>> = Object.freeze({
  quarter: 3,
  third: 4,
  half: 6,
  twoThirds: 8,
  full: 12,
});
const TABLET_WIDTHS: Readonly<Record<DashboardPlanWidth, number>> = Object.freeze({
  quarter: 4,
  third: 4,
  half: 4,
  twoThirds: 8,
  full: 8,
});
const TILE_HEIGHTS: Readonly<Record<DashboardPlanKind, number>> = Object.freeze({
  kpi: 5,
  chart: 9,
  table: 7,
});

function packLayout(
  tiles: readonly Readonly<{ tileId: string; kind: DashboardPlanKind; width: DashboardPlanWidth }>[],
  columns: number,
  widths: Readonly<Record<DashboardPlanWidth, number>>,
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
  tiles: readonly Readonly<{ tileId: string; kind: DashboardPlanKind; width: DashboardPlanWidth }>[],
): DashboardLayouts {
  return {
    desktop: packLayout(tiles, DESKTOP_COLUMNS, DESKTOP_WIDTHS),
    tablet: packLayout(tiles, TABLET_COLUMNS, TABLET_WIDTHS),
  };
}

/** The width word a tile's desktop span reads as (for an element-edit brief). */
export function planWidthFromSpan(span: number | undefined): DashboardPlanWidth {
  if (span === undefined) return "half";
  if (span <= 3) return "quarter";
  if (span <= 4) return "third";
  if (span <= 6) return "half";
  if (span <= 8) return "twoThirds";
  return "full";
}

function planKindFromDisplay(display: DashboardTileDisplay): DashboardPlanKind {
  return display.mode === "kpi" ? "kpi" : display.mode === "chart" ? "chart" : "table";
}

/**
 * An element edit keeps the dashboard's shape: the replacement takes the
 * exact slot the edited tile held on both breakpoints. A tile that changes
 * kind gets its kind's default height; a tile the layout never placed
 * (a pre-0186 document, say) lands beneath everything else.
 */
export function replaceTileInLayouts(
  layouts: DashboardLayouts,
  previous: Readonly<{ tileId: string; display: DashboardTileDisplay }>,
  replacement: Readonly<{ tileId: string; kind: DashboardPlanKind; width: DashboardPlanWidth }>,
): DashboardLayouts {
  const previousKind = planKindFromDisplay(previous.display);
  const replaceIn = (
    items: DashboardLayouts["desktop"],
    columns: number,
    widths: Readonly<Record<DashboardPlanWidth, number>>,
  ): DashboardLayouts["desktop"] => {
    const kept = items.filter((item) => item.i !== previous.tileId);
    const slot = items.find((item) => item.i === previous.tileId);
    const h = previousKind === replacement.kind && slot ? slot.h : TILE_HEIGHTS[replacement.kind];
    if (slot) {
      return [...kept, { i: replacement.tileId, x: slot.x, y: slot.y, w: slot.w, h }];
    }
    const bottom = kept.reduce((max, item) => Math.max(max, item.y + item.h), 0);
    return [...kept, {
      i: replacement.tileId,
      x: 0,
      y: bottom,
      w: Math.min(widths[replacement.width], columns),
      h,
    }];
  };
  return {
    desktop: replaceIn(layouts.desktop, DESKTOP_COLUMNS, DESKTOP_WIDTHS),
    tablet: replaceIn(layouts.tablet, TABLET_COLUMNS, TABLET_WIDTHS),
  };
}

// ---- The architect brief -----------------------------------------------------

const BUILD_HEAD = "Design and build my dashboard.";
const EDIT_HEAD = "Edit one element of my dashboard.";
const TARGET_DASHBOARD_LINE = "Target dashboard: ";
const TARGET_ELEMENT_LINE = "Target element: ";

function describeDisplay(display: DashboardTileDisplay): string {
  if (display.mode === "kpi") {
    return `KPI card${display.valueKey ? ` on ${display.valueKey}` : ""}${display.note ? ` (${display.note})` : ""}`;
  }
  if (display.mode === "chart") {
    const series = display.series?.length ? `, series ${display.series.map((entry) => entry.key).join(", ")}` : "";
    return `${display.chartType} chart, x ${display.xKey}, y ${display.yKey}${series}${display.orientation ? `, ${display.orientation}` : ""}${display.note ? ` (${display.note})` : ""}`;
  }
  return `table${display.note ? ` (${display.note})` : ""}`;
}

/**
 * The architect brief. The design system lives in the runtime's dashboard
 * instructions; this message carries only the owner's ask and the current
 * dashboard so a refinement keeps what works — or, for an element edit
 * (ADR 0134), the one element and its governed query so only that element
 * is rebuilt. The target ids ride along as trailing lines the chat strips
 * from the visible message, so a reopened conversation knows its dashboard.
 */
export function buildDashboardBriefMessage(input: Readonly<{
  instruction: string;
  currentTiles: readonly DashboardTile[];
  dashboardId?: string;
  dashboardTitle?: string | null;
  editTile?: Readonly<{
    tile: DashboardTile;
    /** The tile's desktop span, for the width word. */
    span?: number;
  }>;
}>): string {
  const instruction = input.instruction.trim();
  if (input.editTile) {
    const { tile } = input.editTile;
    const kind = planKindFromDisplay(tile.display);
    const lines = [
      EDIT_HEAD,
      "",
      `Element: "${tile.title}" (${kind})`,
      `What I want changed: ${instruction}`,
      "",
    ];
    if (tile.queryYaml) {
      lines.push("The element's governed query today (YAML):", tile.queryYaml.trim(), "");
    }
    if (tile.snapshot?.columns.length) {
      lines.push(`Its columns today: ${tile.snapshot.columns.map((column) => `${column.key} (${column.type})`).join(", ")}`);
    }
    lines.push(
      `Display today: ${describeDisplay(tile.display)}`,
      `Width today: ${planWidthFromSpan(input.editTile.span)}`,
      "",
      "Rules for an element edit:",
      "- Rebuild ONLY this element; never add, remove or redesign any other element.",
      "- Keep this element's window unless the change asks for another; the whole dashboard reads on one window.",
      `- Run the changed query, check the result, then call ComposeDashboard with exactly ONE tile — the replacement — keeping dashboardTitle "${input.dashboardTitle?.trim() || "Dashboard"}" and a timeframe that states the element's window.`,
      "- Keep the same kind and width unless the change requires otherwise.",
      "",
      `${TARGET_DASHBOARD_LINE}${input.dashboardId ?? "current"}`,
      `${TARGET_ELEMENT_LINE}${tile.tileId}`,
    );
    return lines.join("\n").slice(0, 12_000);
  }

  const lines = [
    BUILD_HEAD,
    "",
    `What I want: ${instruction}`,
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
  if (input.dashboardTitle?.trim()) {
    lines.push("", `Dashboard name today: "${input.dashboardTitle.trim()}" — keep it unless I ask for a new one.`);
  }
  if (input.dashboardId) {
    lines.push("", `${TARGET_DASHBOARD_LINE}${input.dashboardId}`);
  }
  return lines.join("\n").slice(0, 6_000);
}

export type ParsedDashboardBrief =
  | Readonly<{ kind: "build"; instruction: string; dashboardId: string | null }>
  | Readonly<{ kind: "edit"; instruction: string; dashboardId: string | null; tileId: string | null; elementTitle: string }>;

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function trailingId(message: string, prefix: string): string | null {
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(\\S+)\\s*$`, "mu").exec(message);
  const value = match?.[1]?.trim() ?? "";
  return ULID_PATTERN.test(value) ? value : null;
}

/**
 * Reads a persisted brief back: which dashboard (and element) it targeted
 * and the owner's own words, so the chat can show the ask rather than the
 * scaffolding and a reopened conversation can re-enter the right dashboard.
 */
export function parseDashboardBriefMessage(message: string): ParsedDashboardBrief | null {
  if (message.startsWith(BUILD_HEAD)) {
    const match = /^Design and build my dashboard\.\n\nWhat I want: ([\s\S]*?)(?:\n\n(?:You are replacing my current dashboard\.|Dashboard name today:|Target dashboard:)[\s\S]*)?$/u.exec(message);
    const instruction = match?.[1]?.trim() ?? "";
    return { kind: "build", instruction: instruction || message, dashboardId: trailingId(message, TARGET_DASHBOARD_LINE) };
  }
  if (message.startsWith(EDIT_HEAD)) {
    const element = /^Element: "([\s\S]*?)" \((?:kpi|chart|table)\)$/mu.exec(message);
    const instruction = /^What I want changed: ([\s\S]*?)(?=\n\n)/mu.exec(message)?.[1]?.trim() ?? "";
    return {
      kind: "edit",
      instruction: instruction || message,
      dashboardId: trailingId(message, TARGET_DASHBOARD_LINE),
      tileId: trailingId(message, TARGET_ELEMENT_LINE),
      elementTitle: element?.[1]?.trim() ?? "",
    };
  }
  return null;
}

/** The words the chat bubble shows for a build turn's persisted brief. */
export function dashboardBriefDisplayText(message: string): string {
  const parsed = parseDashboardBriefMessage(message);
  if (!parsed) return message;
  if (parsed.kind === "edit" && parsed.elementTitle) return `Edit “${parsed.elementTitle}”: ${parsed.instruction}`;
  return parsed.instruction;
}

/** A tile's desktop span in the document's saved layout. */
export function tileDesktopSpan(dashboard: Pick<DashboardDocument, "layouts">, tileId: string): number | undefined {
  return dashboard.layouts.desktop.find((item) => item.i === tileId)?.w;
}
