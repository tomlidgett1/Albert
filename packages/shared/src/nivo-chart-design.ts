export const NIVO_CHART_DESIGN_VERSION = 1 as const;

export const NIVO_COLOR_SCHEMES = [
  "nivo",
  "category10",
  "accent",
  "dark2",
  "paired",
  "pastel1",
  "pastel2",
  "set1",
  "set2",
  "set3",
  "tableau10",
  "brown_blueGreen",
  "purpleRed_green",
  "pink_yellowGreen",
  "purple_orange",
  "red_blue",
  "red_grey",
  "red_yellow_blue",
  "red_yellow_green",
  "spectral",
  "blues",
  "greens",
  "greys",
  "oranges",
  "purples",
  "reds",
  "blue_green",
  "blue_purple",
  "green_blue",
  "orange_red",
  "purple_blue_green",
  "purple_blue",
  "purple_red",
  "red_purple",
  "yellow_green_blue",
  "yellow_green",
  "yellow_orange_brown",
  "yellow_orange_red",
] as const;

export const LINE_CURVES = [
  "basis",
  "cardinal",
  "catmullRom",
  "linear",
  "monotoneX",
  "monotoneY",
  "natural",
  "step",
  "stepAfter",
  "stepBefore",
] as const;

export const LEGEND_ANCHORS = [
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "top-left",
  "center",
] as const;

export const LEGEND_DIRECTIONS = ["column", "row"] as const;
export const LEGEND_ITEM_DIRECTIONS = [
  "left-to-right",
  "right-to-left",
  "top-to-bottom",
  "bottom-to-top",
] as const;
export const LEGEND_SYMBOL_SHAPES = ["circle", "square", "triangle", "diamond"] as const;
export const AXIS_LEGEND_POSITIONS = ["start", "middle", "end"] as const;
export const BAR_LABEL_POSITIONS = ["start", "middle", "end"] as const;
export const BAR_COLOR_BY = ["id", "indexValue"] as const;
export const BAR_LAYOUTS = ["vertical", "horizontal"] as const;
export const BAR_GROUP_MODES = ["grouped", "stacked"] as const;
export const VALUE_SCALE_TYPES = ["linear", "symlog"] as const;
export const LINE_X_SCALE_TYPES = ["point", "linear", "time", "log", "symlog", "band"] as const;
export const LINE_Y_SCALE_TYPES = ["linear", "log", "symlog"] as const;
export const MOTION_PRESETS = ["default", "gentle", "wobbly", "stiff", "slow", "molasses"] as const;
export const COLOR_MODIFIERS = ["brighter", "darker", "opacity"] as const;
export const INHERITED_COLOR_KINDS = ["literal", "from", "theme"] as const;
export const COLOR_MODES = ["palette", "scheme"] as const;
export const LAYOUT_MODES = ["auto", "manual"] as const;
export const SLICE_MODES = ["false", "x", "y"] as const;
export const CROSSHAIR_TYPES = [
  "x",
  "y",
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "cross",
] as const;
export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export const BAR_LAYERS = ["grid", "axes", "bars", "markers", "legends", "annotations", "totals"] as const;
export const LINE_LAYERS = [
  "grid",
  "markers",
  "axes",
  "areas",
  "crosshair",
  "lines",
  "slices",
  "points",
  "mesh",
  "legends",
] as const;

export type NivoColorScheme = (typeof NIVO_COLOR_SCHEMES)[number];
export type LineCurve = (typeof LINE_CURVES)[number];
export type LegendAnchor = (typeof LEGEND_ANCHORS)[number];
export type MotionPreset = (typeof MOTION_PRESETS)[number];
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export type ChartMargin = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export type InheritedColorDesign = Readonly<{
  kind: (typeof INHERITED_COLOR_KINDS)[number];
  value: string;
  modifiers: readonly (readonly [string, number])[];
}>;

export type ColorDesign = Readonly<{
  mode: (typeof COLOR_MODES)[number];
  palette: readonly string[];
  scheme: NivoColorScheme;
}>;

export type AxisDesign = Readonly<{
  enabled: boolean;
  showLegend: boolean;
  tickSize: number;
  tickPadding: number;
  tickRotation: number;
  truncateTickAt: number;
  legendOffset: number;
  legendPosition: (typeof AXIS_LEGEND_POSITIONS)[number];
  tickValues: string;
}>;

export type LegendDesign = Readonly<{
  enabled: boolean;
  dataFrom: "keys" | "indexes";
  anchor: LegendAnchor;
  direction: (typeof LEGEND_DIRECTIONS)[number];
  justify: boolean;
  translateX: number;
  translateY: number;
  itemWidth: number;
  itemHeight: number;
  itemsSpacing: number;
  itemDirection: (typeof LEGEND_ITEM_DIRECTIONS)[number];
  itemOpacity: number;
  itemTextColor: string;
  itemBackground: string;
  symbolSize: number;
  symbolShape: (typeof LEGEND_SYMBOL_SHAPES)[number];
  symbolSpacing: number;
  symbolBorderWidth: number;
  symbolBorderColor: string;
  toggleSerie: boolean;
}>;

export type MotionDesign = Readonly<{
  preset: MotionPreset | "custom";
  mass: number;
  tension: number;
  friction: number;
  clamp: boolean;
}>;

export type ValueScaleDesign = Readonly<{
  type: (typeof VALUE_SCALE_TYPES)[number];
  min: "auto" | number;
  max: "auto" | number;
  stacked: boolean;
  reverse: boolean;
  nice: boolean;
  clamp: boolean;
}>;

export type IndexScaleDesign = Readonly<{
  type: "band";
  round: boolean;
}>;

export type LineScaleDesign = Readonly<{
  type: string;
  min: "auto" | number;
  max: "auto" | number;
  stacked: boolean;
  reverse: boolean;
  nice: boolean;
  clamp: boolean;
}>;

export type TextStyleDesign = Readonly<{
  fontFamily: string;
  fontSize: number;
  fill: string;
  outlineWidth: number;
  outlineColor: string;
  outlineOpacity: number;
}>;

export type LineStyleDesign = Readonly<{
  stroke: string;
  strokeWidth: number;
  strokeOpacity: number;
  strokeDasharray: string;
}>;

export type NivoThemeDesign = Readonly<{
  background: string;
  text: TextStyleDesign;
  axis: Readonly<{
    domain: Readonly<{ line: LineStyleDesign }>;
    ticks: Readonly<{ line: LineStyleDesign; text: TextStyleDesign }>;
    legend: Readonly<{ text: TextStyleDesign }>;
  }>;
  grid: Readonly<{ line: LineStyleDesign }>;
  crosshair: Readonly<{ line: LineStyleDesign }>;
  legends: Readonly<{
    text: TextStyleDesign;
    title: Readonly<{ text: TextStyleDesign }>;
    ticks: Readonly<{ line: LineStyleDesign; text: TextStyleDesign }>;
    hidden: Readonly<{
      symbolFill: string;
      symbolOpacity: number;
      text: TextStyleDesign;
    }>;
  }>;
  labels: Readonly<{ text: TextStyleDesign }>;
  markers: Readonly<{
    lineColor: string;
    lineStrokeWidth: number;
    text: TextStyleDesign;
  }>;
  dots: Readonly<{ text: TextStyleDesign }>;
  tooltip: Readonly<{
    containerBackground: string;
    containerColor: string;
    containerFontSize: number;
    containerBorderRadius: number;
    containerBoxShadow: string;
    containerPadding: number;
  }>;
  annotations: Readonly<{
    text: TextStyleDesign;
    linkStroke: string;
    linkStrokeWidth: number;
    outlineStroke: string;
    outlineStrokeWidth: number;
    symbolFill: string;
    outlineWidth: number;
    outlineColor: string;
    outlineOpacity: number;
  }>;
}>;

export type BarChartDesign = Readonly<{
  height: number;
  layoutMode: LayoutMode;
  margin: ChartMargin;
  layout: (typeof BAR_LAYOUTS)[number];
  groupMode: (typeof BAR_GROUP_MODES)[number];
  reverse: boolean;
  padding: number;
  innerPadding: number;
  valueScale: ValueScaleDesign;
  indexScale: IndexScaleDesign;
  colorBy: (typeof BAR_COLOR_BY)[number];
  borderRadius: number;
  borderWidth: number;
  borderColor: InheritedColorDesign;
  enableLabel: boolean;
  labelPosition: (typeof BAR_LABEL_POSITIONS)[number];
  labelOffset: number;
  labelSkipWidth: number;
  labelSkipHeight: number;
  labelTextColor: InheritedColorDesign;
  valueFormat: string;
  enableTotals: boolean;
  totalsOffset: number;
  enableGridX: boolean;
  enableGridY: boolean;
  gridXValues: string;
  gridYValues: string;
  isInteractive: boolean;
  animate: boolean;
  animateOnMount: boolean;
  motion: MotionDesign;
  layers: readonly string[];
  axisTop: AxisDesign;
  axisRight: AxisDesign;
  axisBottom: AxisDesign;
  axisLeft: AxisDesign;
  legend: LegendDesign;
  role: string;
  isFocusable: boolean;
  defsJson: string;
  fillJson: string;
  markersJson: string;
  annotationsJson: string;
}>;

export type LineChartDesign = Readonly<{
  height: number;
  layoutMode: LayoutMode;
  margin: ChartMargin;
  maxXTicks: number;
  curve: LineCurve;
  lineWidth: number;
  xScale: LineScaleDesign;
  yScale: LineScaleDesign;
  xFormat: string;
  yFormat: string;
  enableArea: boolean;
  areaOpacity: number;
  areaBaselineValue: number;
  areaBlendMode: (typeof BLEND_MODES)[number];
  enablePoints: boolean;
  pointSize: number;
  pointColor: InheritedColorDesign;
  pointBorderWidth: number;
  pointBorderColor: InheritedColorDesign;
  enablePointLabel: boolean;
  pointLabelYOffset: number;
  enableGridX: boolean;
  enableGridY: boolean;
  gridXValues: string;
  gridYValues: string;
  useMesh: boolean;
  debugMesh: boolean;
  enableSlices: (typeof SLICE_MODES)[number];
  debugSlices: boolean;
  enableCrosshair: boolean;
  crosshairType: (typeof CROSSHAIR_TYPES)[number];
  enableTouchCrosshair: boolean;
  isInteractive: boolean;
  animate: boolean;
  motion: MotionDesign;
  layers: readonly string[];
  axisTop: AxisDesign;
  axisRight: AxisDesign;
  axisBottom: AxisDesign;
  axisLeft: AxisDesign;
  legend: LegendDesign;
  role: string;
  isFocusable: boolean;
  defsJson: string;
  fillJson: string;
  markersJson: string;
}>;

export type NivoChartDesign = Readonly<{
  version: typeof NIVO_CHART_DESIGN_VERSION;
  colors: ColorDesign;
  theme: NivoThemeDesign;
  bar: BarChartDesign;
  line: LineChartDesign;
}>;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringValue(value: unknown, fallback: string, max = 400): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return typeof value === "string" && values.includes(value)
    ? value as Values[number]
    : fallback;
}

function stringList(value: unknown, allowed: readonly string[], fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const next = value.filter((item): item is string => typeof item === "string" && allowed.includes(item));
  return next.length ? [...new Set(next)] : fallback;
}

function scaleBound(value: unknown, fallback: "auto" | number): "auto" | number {
  if (value === "auto") return "auto";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function normalizeMargin(value: unknown, fallback: ChartMargin): ChartMargin {
  const candidate = record(value);
  return {
    top: finiteNumber(candidate.top, fallback.top, 0, 500),
    right: finiteNumber(candidate.right, fallback.right, 0, 500),
    bottom: finiteNumber(candidate.bottom, fallback.bottom, 0, 500),
    left: finiteNumber(candidate.left, fallback.left, 0, 500),
  };
}

function normalizeInheritedColor(value: unknown, fallback: InheritedColorDesign): InheritedColorDesign {
  const candidate = record(value);
  const rawModifiers = Array.isArray(candidate.modifiers) ? candidate.modifiers : fallback.modifiers;
  const modifiers = rawModifiers.flatMap((item) => {
    if (!Array.isArray(item) || item.length < 2) return [];
    const name = enumValue(item[0], COLOR_MODIFIERS, "darker");
    const amount = finiteNumber(item[1], 0.35, -4, 4);
    return [[name, amount] as const];
  });
  return {
    kind: enumValue(candidate.kind, INHERITED_COLOR_KINDS, fallback.kind),
    value: stringValue(candidate.value, fallback.value, 120),
    modifiers: modifiers.length ? modifiers : fallback.modifiers,
  };
}

function normalizeAxis(value: unknown, fallback: AxisDesign): AxisDesign {
  const candidate = record(value);
  return {
    enabled: booleanValue(candidate.enabled, fallback.enabled),
    showLegend: booleanValue(candidate.showLegend, fallback.showLegend),
    tickSize: finiteNumber(candidate.tickSize, fallback.tickSize, 0, 40),
    tickPadding: finiteNumber(candidate.tickPadding, fallback.tickPadding, 0, 80),
    tickRotation: finiteNumber(candidate.tickRotation, fallback.tickRotation, -90, 90),
    truncateTickAt: finiteNumber(candidate.truncateTickAt, fallback.truncateTickAt, 0, 200),
    legendOffset: finiteNumber(candidate.legendOffset, fallback.legendOffset, -500, 500),
    legendPosition: enumValue(candidate.legendPosition, AXIS_LEGEND_POSITIONS, fallback.legendPosition),
    tickValues: stringValue(candidate.tickValues, fallback.tickValues, 400),
  };
}

function normalizeLegend(value: unknown, fallback: LegendDesign): LegendDesign {
  const candidate = record(value);
  return {
    enabled: booleanValue(candidate.enabled, fallback.enabled),
    dataFrom: enumValue(candidate.dataFrom, ["keys", "indexes"] as const, fallback.dataFrom),
    anchor: enumValue(candidate.anchor, LEGEND_ANCHORS, fallback.anchor),
    direction: enumValue(candidate.direction, LEGEND_DIRECTIONS, fallback.direction),
    justify: booleanValue(candidate.justify, fallback.justify),
    translateX: finiteNumber(candidate.translateX, fallback.translateX, -500, 500),
    translateY: finiteNumber(candidate.translateY, fallback.translateY, -500, 500),
    itemWidth: finiteNumber(candidate.itemWidth, fallback.itemWidth, 20, 500),
    itemHeight: finiteNumber(candidate.itemHeight, fallback.itemHeight, 10, 120),
    itemsSpacing: finiteNumber(candidate.itemsSpacing, fallback.itemsSpacing, 0, 80),
    itemDirection: enumValue(candidate.itemDirection, LEGEND_ITEM_DIRECTIONS, fallback.itemDirection),
    itemOpacity: finiteNumber(candidate.itemOpacity, fallback.itemOpacity, 0, 1),
    itemTextColor: stringValue(candidate.itemTextColor, fallback.itemTextColor, 80),
    itemBackground: stringValue(candidate.itemBackground, fallback.itemBackground, 80),
    symbolSize: finiteNumber(candidate.symbolSize, fallback.symbolSize, 2, 48),
    symbolShape: enumValue(candidate.symbolShape, LEGEND_SYMBOL_SHAPES, fallback.symbolShape),
    symbolSpacing: finiteNumber(candidate.symbolSpacing, fallback.symbolSpacing, 0, 40),
    symbolBorderWidth: finiteNumber(candidate.symbolBorderWidth, fallback.symbolBorderWidth, 0, 12),
    symbolBorderColor: stringValue(candidate.symbolBorderColor, fallback.symbolBorderColor, 80),
    toggleSerie: booleanValue(candidate.toggleSerie, fallback.toggleSerie),
  };
}

function normalizeMotion(value: unknown, fallback: MotionDesign): MotionDesign {
  const candidate = record(value);
  const preset = candidate.preset === "custom"
    ? "custom"
    : enumValue(candidate.preset, MOTION_PRESETS, fallback.preset === "custom" ? "default" : fallback.preset);
  return {
    preset,
    mass: finiteNumber(candidate.mass, fallback.mass, 0.1, 20),
    tension: finiteNumber(candidate.tension, fallback.tension, 1, 800),
    friction: finiteNumber(candidate.friction, fallback.friction, 1, 200),
    clamp: booleanValue(candidate.clamp, fallback.clamp),
  };
}

function normalizeValueScale(value: unknown, fallback: ValueScaleDesign): ValueScaleDesign {
  const candidate = record(value);
  return {
    type: enumValue(candidate.type, VALUE_SCALE_TYPES, fallback.type),
    min: scaleBound(candidate.min, fallback.min),
    max: scaleBound(candidate.max, fallback.max),
    stacked: booleanValue(candidate.stacked, fallback.stacked),
    reverse: booleanValue(candidate.reverse, fallback.reverse),
    nice: booleanValue(candidate.nice, fallback.nice),
    clamp: booleanValue(candidate.clamp, fallback.clamp),
  };
}

function normalizeLineScale(
  value: unknown,
  fallback: LineScaleDesign,
  types: readonly string[],
): LineScaleDesign {
  const candidate = record(value);
  return {
    type: enumValue(candidate.type, types, fallback.type),
    min: scaleBound(candidate.min, fallback.min),
    max: scaleBound(candidate.max, fallback.max),
    stacked: booleanValue(candidate.stacked, fallback.stacked),
    reverse: booleanValue(candidate.reverse, fallback.reverse),
    nice: booleanValue(candidate.nice, fallback.nice),
    clamp: booleanValue(candidate.clamp, fallback.clamp),
  };
}

function normalizeTextStyle(value: unknown, fallback: TextStyleDesign): TextStyleDesign {
  const candidate = record(value);
  return {
    fontFamily: stringValue(candidate.fontFamily, fallback.fontFamily, 160),
    fontSize: finiteNumber(candidate.fontSize, fallback.fontSize, 6, 32),
    fill: stringValue(candidate.fill, fallback.fill, 80),
    outlineWidth: finiteNumber(candidate.outlineWidth, fallback.outlineWidth, 0, 12),
    outlineColor: stringValue(candidate.outlineColor, fallback.outlineColor, 80),
    outlineOpacity: finiteNumber(candidate.outlineOpacity, fallback.outlineOpacity, 0, 1),
  };
}

function normalizeLineStyle(value: unknown, fallback: LineStyleDesign): LineStyleDesign {
  const candidate = record(value);
  return {
    stroke: stringValue(candidate.stroke, fallback.stroke, 80),
    strokeWidth: finiteNumber(candidate.strokeWidth, fallback.strokeWidth, 0, 12),
    strokeOpacity: finiteNumber(candidate.strokeOpacity, fallback.strokeOpacity, 0, 1),
    strokeDasharray: stringValue(candidate.strokeDasharray, fallback.strokeDasharray, 40),
  };
}

function defaultText(fill: string, fontSize: number): TextStyleDesign {
  return {
    fontFamily: "var(--font-geist-sans), sans-serif",
    fontSize,
    fill,
    outlineWidth: 0,
    outlineColor: "transparent",
    outlineOpacity: 1,
  };
}

function defaultLine(stroke: string, strokeWidth = 1): LineStyleDesign {
  return {
    stroke,
    strokeWidth,
    strokeOpacity: 1,
    strokeDasharray: "",
  };
}

function defaultAxis(enabled: boolean, showLegend: boolean, legendOffset: number): AxisDesign {
  return {
    enabled,
    showLegend,
    tickSize: 5,
    tickPadding: 5,
    tickRotation: 0,
    truncateTickAt: 0,
    legendOffset,
    legendPosition: "middle",
    tickValues: "",
  };
}

function defaultLegend(partial: Partial<LegendDesign>): LegendDesign {
  return {
    enabled: true,
    dataFrom: "keys",
    anchor: "bottom-left",
    direction: "row",
    justify: false,
    translateX: 0,
    translateY: 62,
    itemWidth: 128,
    itemHeight: 18,
    itemsSpacing: 8,
    itemDirection: "left-to-right",
    itemOpacity: 0.85,
    itemTextColor: "var(--dash-text-muted)",
    itemBackground: "transparent",
    symbolSize: 9,
    symbolShape: "circle",
    symbolSpacing: 8,
    symbolBorderWidth: 0,
    symbolBorderColor: "transparent",
    toggleSerie: false,
    ...partial,
  };
}

function defaultMotion(): MotionDesign {
  return {
    preset: "custom",
    mass: 1,
    tension: 210,
    friction: 28,
    clamp: true,
  };
}

const defaultMuted = "var(--dash-text-muted)";
const defaultBody = "var(--dash-text-body)";
const defaultGrid = "var(--dash-chart-grid)";
const defaultBorder = "var(--dash-border-soft)";

export const DEFAULT_NIVO_CHART_DESIGN: NivoChartDesign = {
  version: NIVO_CHART_DESIGN_VERSION,
  colors: {
    mode: "palette",
    palette: [
      "var(--dash-chart-1)",
      "var(--dash-chart-2)",
      "var(--dash-chart-3)",
      "var(--dash-chart-4)",
    ],
    scheme: "nivo",
  },
  theme: {
    background: "transparent",
    text: defaultText(defaultMuted, 11),
    axis: {
      domain: { line: defaultLine(defaultBorder) },
      ticks: {
        line: defaultLine(defaultBorder),
        text: defaultText(defaultMuted, 10),
      },
      legend: { text: defaultText(defaultBody, 11) },
    },
    grid: { line: defaultLine(defaultGrid) },
    crosshair: { line: defaultLine("var(--dash-text-faint)", 1) },
    legends: {
      text: defaultText(defaultMuted, 10),
      title: { text: defaultText(defaultBody, 11) },
      ticks: {
        line: defaultLine(defaultBorder),
        text: defaultText(defaultMuted, 10),
      },
      hidden: {
        symbolFill: defaultMuted,
        symbolOpacity: 0.4,
        text: defaultText(defaultMuted, 10),
      },
    },
    labels: { text: defaultText("var(--dash-chart-label-on-fill)", 11) },
    markers: {
      lineColor: defaultBorder,
      lineStrokeWidth: 1,
      text: defaultText(defaultMuted, 10),
    },
    dots: { text: defaultText(defaultBody, 10) },
    tooltip: {
      containerBackground: "transparent",
      containerColor: defaultBody,
      containerFontSize: 12,
      containerBorderRadius: 0,
      containerBoxShadow: "none",
      containerPadding: 0,
    },
    annotations: {
      text: defaultText(defaultBody, 10),
      linkStroke: defaultBorder,
      linkStrokeWidth: 1,
      outlineStroke: defaultBorder,
      outlineStrokeWidth: 2,
      symbolFill: "var(--dash-chart-1)",
      outlineWidth: 2,
      outlineColor: "#ffffff",
      outlineOpacity: 1,
    },
  },
  bar: {
    height: 320,
    layoutMode: "auto",
    margin: { top: 22, right: 20, bottom: 70, left: 74 },
    layout: "vertical",
    groupMode: "grouped",
    reverse: false,
    padding: 0.28,
    innerPadding: 3,
    valueScale: {
      type: "linear",
      min: "auto",
      max: "auto",
      stacked: false,
      reverse: false,
      nice: true,
      clamp: false,
    },
    indexScale: { type: "band", round: true },
    colorBy: "id",
    borderRadius: 5,
    borderWidth: 1,
    borderColor: { kind: "from", value: "color", modifiers: [["darker", 0.35]] },
    enableLabel: true,
    labelPosition: "middle",
    labelOffset: 0,
    labelSkipWidth: 42,
    labelSkipHeight: 20,
    labelTextColor: { kind: "literal", value: "var(--dash-chart-label-on-fill)", modifiers: [] },
    valueFormat: "",
    enableTotals: false,
    totalsOffset: 10,
    enableGridX: false,
    enableGridY: true,
    gridXValues: "",
    gridYValues: "",
    isInteractive: true,
    animate: true,
    animateOnMount: true,
    motion: defaultMotion(),
    layers: [...BAR_LAYERS],
    axisTop: defaultAxis(false, false, -36),
    axisRight: defaultAxis(false, false, 40),
    axisBottom: defaultAxis(true, false, 36),
    axisLeft: defaultAxis(true, false, -40),
    legend: defaultLegend({}),
    role: "img",
    isFocusable: true,
    defsJson: "[]",
    fillJson: "[]",
    markersJson: "[]",
    annotationsJson: "[]",
  },
  line: {
    height: 340,
    layoutMode: "auto",
    margin: { top: 50, right: 48, bottom: 94, left: 112 },
    maxXTicks: 8,
    curve: "basis",
    lineWidth: 3,
    xScale: {
      type: "point",
      min: "auto",
      max: "auto",
      stacked: false,
      reverse: false,
      nice: false,
      clamp: false,
    },
    yScale: {
      type: "linear",
      min: "auto",
      max: "auto",
      stacked: true,
      reverse: false,
      nice: true,
      clamp: false,
    },
    xFormat: "",
    yFormat: "",
    enableArea: false,
    areaOpacity: 0.25,
    areaBaselineValue: 0,
    areaBlendMode: "normal",
    enablePoints: false,
    pointSize: 10,
    pointColor: { kind: "theme", value: "background", modifiers: [] },
    pointBorderWidth: 2,
    pointBorderColor: { kind: "from", value: "seriesColor", modifiers: [] },
    enablePointLabel: false,
    pointLabelYOffset: -12,
    enableGridX: false,
    enableGridY: true,
    gridXValues: "",
    gridYValues: "",
    useMesh: true,
    debugMesh: false,
    enableSlices: "false",
    debugSlices: false,
    enableCrosshair: true,
    crosshairType: "x",
    enableTouchCrosshair: true,
    isInteractive: true,
    animate: true,
    motion: defaultMotion(),
    layers: [...LINE_LAYERS],
    axisTop: defaultAxis(false, false, -36),
    axisRight: defaultAxis(false, false, 40),
    axisBottom: defaultAxis(true, true, 36),
    axisLeft: defaultAxis(true, true, -56),
    legend: defaultLegend({
      anchor: "bottom-right",
      direction: "row",
      translateY: 68,
      itemWidth: 120,
      itemHeight: 22,
      itemsSpacing: 0,
      symbolSize: 16,
    }),
    role: "img",
    isFocusable: true,
    defsJson: "[]",
    fillJson: "[]",
    markersJson: "[]",
  },
};

function normalizeColors(value: unknown): ColorDesign {
  const candidate = record(value);
  const palette = Array.isArray(candidate.palette)
    ? candidate.palette.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 16)
    : DEFAULT_NIVO_CHART_DESIGN.colors.palette;
  return {
    mode: enumValue(candidate.mode, COLOR_MODES, DEFAULT_NIVO_CHART_DESIGN.colors.mode),
    palette: palette.length ? palette : DEFAULT_NIVO_CHART_DESIGN.colors.palette,
    scheme: enumValue(candidate.scheme, NIVO_COLOR_SCHEMES, DEFAULT_NIVO_CHART_DESIGN.colors.scheme),
  };
}

function normalizeTheme(value: unknown): NivoThemeDesign {
  const fallback = DEFAULT_NIVO_CHART_DESIGN.theme;
  const candidate = record(value);
  const axis = record(candidate.axis);
  const legends = record(candidate.legends);
  const tooltip = record(candidate.tooltip);
  const annotations = record(candidate.annotations);
  const markers = record(candidate.markers);
  const hidden = record(legends.hidden);
  return {
    background: stringValue(candidate.background, fallback.background, 80),
    text: normalizeTextStyle(candidate.text, fallback.text),
    axis: {
      domain: { line: normalizeLineStyle(record(axis.domain).line, fallback.axis.domain.line) },
      ticks: {
        line: normalizeLineStyle(record(axis.ticks).line, fallback.axis.ticks.line),
        text: normalizeTextStyle(record(axis.ticks).text, fallback.axis.ticks.text),
      },
      legend: { text: normalizeTextStyle(record(axis.legend).text, fallback.axis.legend.text) },
    },
    grid: { line: normalizeLineStyle(record(candidate.grid).line, fallback.grid.line) },
    crosshair: { line: normalizeLineStyle(record(candidate.crosshair).line, fallback.crosshair.line) },
    legends: {
      text: normalizeTextStyle(legends.text, fallback.legends.text),
      title: { text: normalizeTextStyle(record(legends.title).text, fallback.legends.title.text) },
      ticks: {
        line: normalizeLineStyle(record(legends.ticks).line, fallback.legends.ticks.line),
        text: normalizeTextStyle(record(legends.ticks).text, fallback.legends.ticks.text),
      },
      hidden: {
        symbolFill: stringValue(hidden.symbolFill, fallback.legends.hidden.symbolFill, 80),
        symbolOpacity: finiteNumber(hidden.symbolOpacity, fallback.legends.hidden.symbolOpacity, 0, 1),
        text: normalizeTextStyle(hidden.text, fallback.legends.hidden.text),
      },
    },
    labels: { text: normalizeTextStyle(record(candidate.labels).text, fallback.labels.text) },
    markers: {
      lineColor: stringValue(markers.lineColor, fallback.markers.lineColor, 80),
      lineStrokeWidth: finiteNumber(markers.lineStrokeWidth, fallback.markers.lineStrokeWidth, 0, 12),
      text: normalizeTextStyle(markers.text, fallback.markers.text),
    },
    dots: { text: normalizeTextStyle(record(candidate.dots).text, fallback.dots.text) },
    tooltip: {
      containerBackground: stringValue(tooltip.containerBackground, fallback.tooltip.containerBackground, 80),
      containerColor: stringValue(tooltip.containerColor, fallback.tooltip.containerColor, 80),
      containerFontSize: finiteNumber(tooltip.containerFontSize, fallback.tooltip.containerFontSize, 8, 24),
      containerBorderRadius: finiteNumber(tooltip.containerBorderRadius, fallback.tooltip.containerBorderRadius, 0, 32),
      containerBoxShadow: stringValue(tooltip.containerBoxShadow, fallback.tooltip.containerBoxShadow, 200),
      containerPadding: finiteNumber(tooltip.containerPadding, fallback.tooltip.containerPadding, 0, 32),
    },
    annotations: {
      text: normalizeTextStyle(annotations.text, fallback.annotations.text),
      linkStroke: stringValue(annotations.linkStroke, fallback.annotations.linkStroke, 80),
      linkStrokeWidth: finiteNumber(annotations.linkStrokeWidth, fallback.annotations.linkStrokeWidth, 0, 12),
      outlineStroke: stringValue(annotations.outlineStroke, fallback.annotations.outlineStroke, 80),
      outlineStrokeWidth: finiteNumber(annotations.outlineStrokeWidth, fallback.annotations.outlineStrokeWidth, 0, 12),
      symbolFill: stringValue(annotations.symbolFill, fallback.annotations.symbolFill, 80),
      outlineWidth: finiteNumber(annotations.outlineWidth, fallback.annotations.outlineWidth, 0, 12),
      outlineColor: stringValue(annotations.outlineColor, fallback.annotations.outlineColor, 80),
      outlineOpacity: finiteNumber(annotations.outlineOpacity, fallback.annotations.outlineOpacity, 0, 1),
    },
  };
}

function normalizeBar(value: unknown): BarChartDesign {
  const fallback = DEFAULT_NIVO_CHART_DESIGN.bar;
  const candidate = record(value);
  return {
    height: finiteNumber(candidate.height, fallback.height, 180, 900),
    layoutMode: enumValue(candidate.layoutMode, LAYOUT_MODES, fallback.layoutMode),
    margin: normalizeMargin(candidate.margin, fallback.margin),
    layout: enumValue(candidate.layout, BAR_LAYOUTS, fallback.layout),
    groupMode: enumValue(candidate.groupMode, BAR_GROUP_MODES, fallback.groupMode),
    reverse: booleanValue(candidate.reverse, fallback.reverse),
    padding: finiteNumber(candidate.padding, fallback.padding, 0, 0.95),
    innerPadding: finiteNumber(candidate.innerPadding, fallback.innerPadding, 0, 40),
    valueScale: normalizeValueScale(candidate.valueScale, fallback.valueScale),
    indexScale: {
      type: "band",
      round: booleanValue(record(candidate.indexScale).round, fallback.indexScale.round),
    },
    colorBy: enumValue(candidate.colorBy, BAR_COLOR_BY, fallback.colorBy),
    borderRadius: finiteNumber(candidate.borderRadius, fallback.borderRadius, 0, 40),
    borderWidth: finiteNumber(candidate.borderWidth, fallback.borderWidth, 0, 12),
    borderColor: normalizeInheritedColor(candidate.borderColor, fallback.borderColor),
    enableLabel: booleanValue(candidate.enableLabel, fallback.enableLabel),
    labelPosition: enumValue(candidate.labelPosition, BAR_LABEL_POSITIONS, fallback.labelPosition),
    labelOffset: finiteNumber(candidate.labelOffset, fallback.labelOffset, -80, 80),
    labelSkipWidth: finiteNumber(candidate.labelSkipWidth, fallback.labelSkipWidth, 0, 200),
    labelSkipHeight: finiteNumber(candidate.labelSkipHeight, fallback.labelSkipHeight, 0, 200),
    labelTextColor: normalizeInheritedColor(candidate.labelTextColor, fallback.labelTextColor),
    valueFormat: stringValue(candidate.valueFormat, fallback.valueFormat, 40),
    enableTotals: booleanValue(candidate.enableTotals, fallback.enableTotals),
    totalsOffset: finiteNumber(candidate.totalsOffset, fallback.totalsOffset, -80, 80),
    enableGridX: booleanValue(candidate.enableGridX, fallback.enableGridX),
    enableGridY: booleanValue(candidate.enableGridY, fallback.enableGridY),
    gridXValues: stringValue(candidate.gridXValues, fallback.gridXValues, 200),
    gridYValues: stringValue(candidate.gridYValues, fallback.gridYValues, 200),
    isInteractive: booleanValue(candidate.isInteractive, fallback.isInteractive),
    animate: booleanValue(candidate.animate, fallback.animate),
    animateOnMount: booleanValue(candidate.animateOnMount, fallback.animateOnMount),
    motion: normalizeMotion(candidate.motion, fallback.motion),
    layers: stringList(candidate.layers, BAR_LAYERS, fallback.layers),
    axisTop: normalizeAxis(candidate.axisTop, fallback.axisTop),
    axisRight: normalizeAxis(candidate.axisRight, fallback.axisRight),
    axisBottom: normalizeAxis(candidate.axisBottom, fallback.axisBottom),
    axisLeft: normalizeAxis(candidate.axisLeft, fallback.axisLeft),
    legend: normalizeLegend(candidate.legend, fallback.legend),
    role: stringValue(candidate.role, fallback.role, 40),
    isFocusable: booleanValue(candidate.isFocusable, fallback.isFocusable),
    defsJson: stringValue(candidate.defsJson, fallback.defsJson, 8_000),
    fillJson: stringValue(candidate.fillJson, fallback.fillJson, 8_000),
    markersJson: stringValue(candidate.markersJson, fallback.markersJson, 8_000),
    annotationsJson: stringValue(candidate.annotationsJson, fallback.annotationsJson, 8_000),
  };
}

function normalizeLine(value: unknown): LineChartDesign {
  const fallback = DEFAULT_NIVO_CHART_DESIGN.line;
  const candidate = record(value);
  return {
    height: finiteNumber(candidate.height, fallback.height, 180, 900),
    layoutMode: enumValue(candidate.layoutMode, LAYOUT_MODES, fallback.layoutMode),
    margin: normalizeMargin(candidate.margin, fallback.margin),
    maxXTicks: finiteNumber(candidate.maxXTicks, fallback.maxXTicks, 2, 40),
    curve: enumValue(candidate.curve, LINE_CURVES, fallback.curve),
    lineWidth: finiteNumber(candidate.lineWidth, fallback.lineWidth, 0, 16),
    xScale: normalizeLineScale(candidate.xScale, fallback.xScale, LINE_X_SCALE_TYPES),
    yScale: normalizeLineScale(candidate.yScale, fallback.yScale, LINE_Y_SCALE_TYPES),
    xFormat: stringValue(candidate.xFormat, fallback.xFormat, 40),
    yFormat: stringValue(candidate.yFormat, fallback.yFormat, 40),
    enableArea: booleanValue(candidate.enableArea, fallback.enableArea),
    areaOpacity: finiteNumber(candidate.areaOpacity, fallback.areaOpacity, 0, 1),
    areaBaselineValue: finiteNumber(candidate.areaBaselineValue, fallback.areaBaselineValue, -1_000_000, 1_000_000),
    areaBlendMode: enumValue(candidate.areaBlendMode, BLEND_MODES, fallback.areaBlendMode),
    enablePoints: booleanValue(candidate.enablePoints, fallback.enablePoints),
    pointSize: finiteNumber(candidate.pointSize, fallback.pointSize, 0, 40),
    pointColor: normalizeInheritedColor(candidate.pointColor, fallback.pointColor),
    pointBorderWidth: finiteNumber(candidate.pointBorderWidth, fallback.pointBorderWidth, 0, 12),
    pointBorderColor: normalizeInheritedColor(candidate.pointBorderColor, fallback.pointBorderColor),
    enablePointLabel: booleanValue(candidate.enablePointLabel, fallback.enablePointLabel),
    pointLabelYOffset: finiteNumber(candidate.pointLabelYOffset, fallback.pointLabelYOffset, -80, 80),
    enableGridX: booleanValue(candidate.enableGridX, fallback.enableGridX),
    enableGridY: booleanValue(candidate.enableGridY, fallback.enableGridY),
    gridXValues: stringValue(candidate.gridXValues, fallback.gridXValues, 200),
    gridYValues: stringValue(candidate.gridYValues, fallback.gridYValues, 200),
    useMesh: booleanValue(candidate.useMesh, fallback.useMesh),
    debugMesh: booleanValue(candidate.debugMesh, fallback.debugMesh),
    enableSlices: enumValue(candidate.enableSlices, SLICE_MODES, fallback.enableSlices),
    debugSlices: booleanValue(candidate.debugSlices, fallback.debugSlices),
    enableCrosshair: booleanValue(candidate.enableCrosshair, fallback.enableCrosshair),
    crosshairType: enumValue(candidate.crosshairType, CROSSHAIR_TYPES, fallback.crosshairType),
    enableTouchCrosshair: booleanValue(candidate.enableTouchCrosshair, fallback.enableTouchCrosshair),
    isInteractive: booleanValue(candidate.isInteractive, fallback.isInteractive),
    animate: booleanValue(candidate.animate, fallback.animate),
    motion: normalizeMotion(candidate.motion, fallback.motion),
    layers: stringList(candidate.layers, LINE_LAYERS, fallback.layers),
    axisTop: normalizeAxis(candidate.axisTop, fallback.axisTop),
    axisRight: normalizeAxis(candidate.axisRight, fallback.axisRight),
    axisBottom: normalizeAxis(candidate.axisBottom, fallback.axisBottom),
    axisLeft: normalizeAxis(candidate.axisLeft, fallback.axisLeft),
    legend: normalizeLegend(candidate.legend, fallback.legend),
    role: stringValue(candidate.role, fallback.role, 40),
    isFocusable: booleanValue(candidate.isFocusable, fallback.isFocusable),
    defsJson: stringValue(candidate.defsJson, fallback.defsJson, 8_000),
    fillJson: stringValue(candidate.fillJson, fallback.fillJson, 8_000),
    markersJson: stringValue(candidate.markersJson, fallback.markersJson, 8_000),
  };
}

export function normalizeNivoChartDesign(value: unknown): NivoChartDesign {
  const candidate = record(value);
  return {
    version: NIVO_CHART_DESIGN_VERSION,
    colors: normalizeColors(candidate.colors),
    theme: normalizeTheme(candidate.theme),
    bar: normalizeBar(candidate.bar),
    line: normalizeLine(candidate.line),
  };
}

export function parseJsonArray(value: string): unknown[] | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseTickValues(value: string): number | Array<string | number> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/u.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return undefined;
  return parts.map((part) => {
    const numeric = Number(part);
    return Number.isFinite(numeric) && part !== "" ? numeric : part;
  });
}

export function inheritedColorToNivo(color: InheritedColorDesign): unknown {
  if (color.kind === "literal") return color.value;
  if (color.kind === "theme") return { theme: color.value };
  return color.modifiers.length
    ? { from: color.value, modifiers: color.modifiers.map(([name, amount]) => [name, amount]) }
    : { from: color.value };
}

export function colorsToNivo(colors: ColorDesign): unknown {
  return colors.mode === "scheme" ? { scheme: colors.scheme } : [...colors.palette];
}

export function motionToNivo(motion: MotionDesign): unknown {
  if (motion.preset !== "custom") return motion.preset;
  return {
    mass: motion.mass,
    tension: motion.tension,
    friction: motion.friction,
    clamp: motion.clamp,
  };
}

export function axisToNivo(
  axis: AxisDesign,
  legend?: string,
  format?: (value: string | number) => string,
  tickValues?: unknown,
): Record<string, unknown> | null {
  if (!axis.enabled) return null;
  return {
    tickSize: axis.tickSize,
    tickPadding: axis.tickPadding,
    tickRotation: axis.tickRotation,
    truncateTickAt: axis.truncateTickAt || undefined,
    legend: axis.showLegend ? legend : undefined,
    legendOffset: axis.legendOffset,
    legendPosition: axis.legendPosition,
    format,
    tickValues: tickValues ?? parseTickValues(axis.tickValues),
  };
}

export function legendToNivo(legend: LegendDesign, dataFrom?: "keys" | "indexes"): Record<string, unknown> {
  return {
    ...(dataFrom ? { dataFrom } : { dataFrom: legend.dataFrom }),
    anchor: legend.anchor,
    direction: legend.direction,
    justify: legend.justify,
    translateX: legend.translateX,
    translateY: legend.translateY,
    itemWidth: legend.itemWidth,
    itemHeight: legend.itemHeight,
    itemsSpacing: legend.itemsSpacing,
    itemDirection: legend.itemDirection,
    itemOpacity: legend.itemOpacity,
    itemTextColor: legend.itemTextColor,
    itemBackground: legend.itemBackground || undefined,
    symbolSize: legend.symbolSize,
    symbolShape: legend.symbolShape,
    symbolSpacing: legend.symbolSpacing,
    symbolBorderWidth: legend.symbolBorderWidth,
    symbolBorderColor: legend.symbolBorderColor,
    toggleSerie: legend.toggleSerie,
  };
}

export function themeToNivo(theme: NivoThemeDesign): Record<string, unknown> {
  return {
    background: theme.background,
    text: theme.text,
    axis: theme.axis,
    grid: theme.grid,
    crosshair: theme.crosshair,
    legends: {
      text: theme.legends.text,
      title: theme.legends.title,
      ticks: theme.legends.ticks,
      hidden: {
        symbol: {
          fill: theme.legends.hidden.symbolFill,
          opacity: theme.legends.hidden.symbolOpacity,
        },
        text: theme.legends.hidden.text,
      },
    },
    labels: theme.labels,
    markers: theme.markers,
    dots: theme.dots,
    tooltip: {
      container: {
        background: theme.tooltip.containerBackground,
        color: theme.tooltip.containerColor,
        fontSize: theme.tooltip.containerFontSize,
        borderRadius: theme.tooltip.containerBorderRadius,
        boxShadow: theme.tooltip.containerBoxShadow,
        padding: theme.tooltip.containerPadding,
      },
    },
    annotations: {
      text: theme.annotations.text,
      link: {
        stroke: theme.annotations.linkStroke,
        strokeWidth: theme.annotations.linkStrokeWidth,
        outlineWidth: theme.annotations.outlineWidth,
        outlineColor: theme.annotations.outlineColor,
        outlineOpacity: theme.annotations.outlineOpacity,
      },
      outline: {
        stroke: theme.annotations.outlineStroke,
        strokeWidth: theme.annotations.outlineStrokeWidth,
        outlineWidth: theme.annotations.outlineWidth,
        outlineColor: theme.annotations.outlineColor,
        outlineOpacity: theme.annotations.outlineOpacity,
      },
      symbol: {
        fill: theme.annotations.symbolFill,
        outlineWidth: theme.annotations.outlineWidth,
        outlineColor: theme.annotations.outlineColor,
        outlineOpacity: theme.annotations.outlineOpacity,
      },
    },
  };
}

function scaleToNivo(scale: ValueScaleDesign | LineScaleDesign): Record<string, unknown> {
  return {
    type: scale.type,
    min: scale.min,
    max: scale.max,
    stacked: "stacked" in scale ? scale.stacked : undefined,
    reverse: scale.reverse,
    nice: scale.nice,
    clamp: scale.clamp,
  };
}

export function barDesignToNivoProps(design: NivoChartDesign): Record<string, unknown> {
  const bar = design.bar;
  return {
    margin: bar.margin,
    layout: bar.layout,
    groupMode: bar.groupMode,
    reverse: bar.reverse,
    padding: bar.padding,
    innerPadding: bar.innerPadding,
    valueScale: scaleToNivo(bar.valueScale),
    indexScale: bar.indexScale,
    colors: colorsToNivo(design.colors),
    colorBy: bar.colorBy,
    borderRadius: bar.borderRadius,
    borderWidth: bar.borderWidth,
    borderColor: inheritedColorToNivo(bar.borderColor),
    enableLabel: bar.enableLabel,
    labelPosition: bar.labelPosition,
    labelOffset: bar.labelOffset,
    labelSkipWidth: bar.labelSkipWidth,
    labelSkipHeight: bar.labelSkipHeight,
    labelTextColor: inheritedColorToNivo(bar.labelTextColor),
    valueFormat: bar.valueFormat || undefined,
    enableTotals: bar.enableTotals,
    totalsOffset: bar.totalsOffset,
    enableGridX: bar.enableGridX,
    enableGridY: bar.enableGridY,
    gridXValues: parseTickValues(bar.gridXValues),
    gridYValues: parseTickValues(bar.gridYValues),
    isInteractive: bar.isInteractive,
    animate: bar.animate,
    animateOnMount: bar.animateOnMount,
    motionConfig: motionToNivo(bar.motion),
    layers: bar.layers,
    axisTop: axisToNivo(bar.axisTop),
    axisRight: axisToNivo(bar.axisRight),
    axisBottom: axisToNivo(bar.axisBottom),
    axisLeft: axisToNivo(bar.axisLeft),
    legends: bar.legend.enabled ? [legendToNivo(bar.legend)] : [],
    theme: themeToNivo(design.theme),
    role: bar.role,
    isFocusable: bar.isFocusable,
    defs: parseJsonArray(bar.defsJson),
    fill: parseJsonArray(bar.fillJson),
    markers: parseJsonArray(bar.markersJson),
    annotations: parseJsonArray(bar.annotationsJson),
  };
}

export function lineDesignToNivoProps(design: NivoChartDesign): Record<string, unknown> {
  const line = design.line;
  return {
    margin: line.margin,
    curve: line.curve,
    lineWidth: line.lineWidth,
    xScale: scaleToNivo(line.xScale),
    yScale: scaleToNivo(line.yScale),
    xFormat: line.xFormat || undefined,
    yFormat: line.yFormat || undefined,
    colors: colorsToNivo(design.colors),
    enableArea: line.enableArea,
    areaOpacity: line.areaOpacity,
    areaBaselineValue: line.areaBaselineValue,
    areaBlendMode: line.areaBlendMode,
    enablePoints: line.enablePoints,
    pointSize: line.pointSize,
    pointColor: inheritedColorToNivo(line.pointColor),
    pointBorderWidth: line.pointBorderWidth,
    pointBorderColor: inheritedColorToNivo(line.pointBorderColor),
    enablePointLabel: line.enablePointLabel,
    pointLabelYOffset: line.pointLabelYOffset,
    enableGridX: line.enableGridX,
    enableGridY: line.enableGridY,
    gridXValues: parseTickValues(line.gridXValues),
    gridYValues: parseTickValues(line.gridYValues),
    useMesh: line.useMesh,
    debugMesh: line.debugMesh,
    enableSlices: line.enableSlices === "false" ? false : line.enableSlices,
    debugSlices: line.debugSlices,
    enableCrosshair: line.enableCrosshair,
    crosshairType: line.crosshairType,
    enableTouchCrosshair: line.enableTouchCrosshair,
    isInteractive: line.isInteractive,
    animate: line.animate,
    motionConfig: motionToNivo(line.motion),
    layers: line.layers,
    axisTop: axisToNivo(line.axisTop),
    axisRight: axisToNivo(line.axisRight),
    axisBottom: axisToNivo(line.axisBottom),
    axisLeft: axisToNivo(line.axisLeft),
    legends: line.legend.enabled ? [legendToNivo(line.legend)] : [],
    theme: themeToNivo(design.theme),
    role: line.role,
    isFocusable: line.isFocusable,
    defs: parseJsonArray(line.defsJson),
    fill: parseJsonArray(line.fillJson),
    markers: parseJsonArray(line.markersJson),
  };
}
