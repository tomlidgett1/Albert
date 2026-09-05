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

export type LineCurve = (typeof LINE_CURVES)[number];
export type LegendAnchor = (typeof LEGEND_ANCHORS)[number];
export type ChartType = "line" | "bar";

export type ChartMarginConfig = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export type ChartAxisDebugConfig = Readonly<{
  showLegend: boolean;
  tickSize: number;
  tickPadding: number;
  tickRotation: number;
  truncateTickAt: number;
  legendOffset: number;
}>;

export type ChartLegendDebugConfig = Readonly<{
  enabled: boolean;
  anchor: LegendAnchor;
  direction: "column" | "row";
  translateX: number;
  translateY: number;
  itemWidth: number;
  itemHeight: number;
  itemsSpacing: number;
  symbolSize: number;
}>;

export type LineChartDebugConfig = Readonly<{
  chartType: "line";
  height: number;
  maxXTicks: number;
  margin: ChartMarginConfig;
  yScale: Readonly<{
    min: "auto" | 0;
    max: "auto";
    stacked: boolean;
    reverse: boolean;
  }>;
  curve: LineCurve;
  lineWidth: number;
  enableArea: boolean;
  areaOpacity: number;
  enableGridX: boolean;
  enableGridY: boolean;
  enablePoints: boolean;
  pointSize: number;
  pointBorderWidth: number;
  enableTouchCrosshair: boolean;
  useMesh: boolean;
  axisBottom: ChartAxisDebugConfig;
  axisLeft: ChartAxisDebugConfig;
  legend: ChartLegendDebugConfig;
}>;

export type BarChartDebugConfig = Readonly<{
  chartType: "bar";
  height: number;
  margin: ChartMarginConfig;
  layout: "horizontal" | "vertical";
  groupMode: "grouped" | "stacked";
  padding: number;
  innerPadding: number;
  borderRadius: number;
  borderWidth: number;
  enableGridX: boolean;
  enableGridY: boolean;
  enableLabel: boolean;
  labelSkipWidth: number;
  labelSkipHeight: number;
  axisBottom: ChartAxisDebugConfig;
  axisLeft: ChartAxisDebugConfig;
  legend: ChartLegendDebugConfig;
}>;

export type NivoChartDebugConfig = LineChartDebugConfig | BarChartDebugConfig;

export function createLineChartDebugConfig({
  height,
  margin,
  yAxisLegendOffset,
  legendTranslateX,
  legendTranslateY,
  legendItemWidth,
}: {
  height: number;
  margin: ChartMarginConfig;
  yAxisLegendOffset: number;
  legendTranslateX: number;
  legendTranslateY: number;
  legendItemWidth: number;
}): LineChartDebugConfig {
  return {
    chartType: "line",
    height,
    maxXTicks: 8,
    margin,
    yScale: { min: "auto", max: "auto", stacked: true, reverse: false },
    curve: "basis",
    lineWidth: 3,
    enableArea: false,
    areaOpacity: 0.25,
    enableGridX: false,
    enableGridY: true,
    enablePoints: false,
    pointSize: 10,
    pointBorderWidth: 2,
    enableTouchCrosshair: true,
    useMesh: true,
    axisBottom: {
      showLegend: true,
      tickSize: 5,
      tickPadding: 5,
      tickRotation: 0,
      truncateTickAt: 0,
      legendOffset: 36,
    },
    axisLeft: {
      showLegend: true,
      tickSize: 5,
      tickPadding: 5,
      tickRotation: 0,
      truncateTickAt: 0,
      legendOffset: yAxisLegendOffset,
    },
    legend: {
      enabled: true,
      anchor: "bottom-right",
      direction: "row",
      translateX: legendTranslateX,
      translateY: legendTranslateY,
      itemWidth: legendItemWidth,
      itemHeight: 22,
      itemsSpacing: 0,
      symbolSize: 16,
    },
  };
}

export function createBarChartDebugConfig({
  height,
  horizontal,
  hasLegend,
  longestXLabel,
  rowCount,
}: {
  height: number;
  horizontal: boolean;
  hasLegend: boolean;
  longestXLabel: number;
  rowCount: number;
}): BarChartDebugConfig {
  return {
    chartType: "bar",
    height,
    margin: horizontal
      ? { top: 22, right: 24, bottom: hasLegend ? 88 : 58, left: Math.min(180, Math.max(92, longestXLabel * 7)) }
      : { top: 22, right: 20, bottom: hasLegend ? 102 : 70, left: 74 },
    layout: horizontal ? "horizontal" : "vertical",
    groupMode: "grouped",
    padding: 0.28,
    innerPadding: 3,
    borderRadius: 5,
    borderWidth: 1,
    enableGridX: horizontal,
    enableGridY: !horizontal,
    enableLabel: !horizontal && !hasLegend && rowCount <= 8,
    labelSkipWidth: 42,
    labelSkipHeight: 20,
    axisBottom: {
      showLegend: false,
      tickSize: 4,
      tickPadding: horizontal ? 7 : 8,
      tickRotation: !horizontal && longestXLabel > 9 ? -28 : 0,
      truncateTickAt: 0,
      legendOffset: 36,
    },
    axisLeft: {
      showLegend: false,
      tickSize: 4,
      tickPadding: 7,
      tickRotation: 0,
      truncateTickAt: horizontal ? 24 : 0,
      legendOffset: -40,
    },
    legend: {
      enabled: hasLegend,
      anchor: "bottom-left",
      direction: "row",
      translateX: 0,
      translateY: 62,
      itemWidth: 128,
      itemHeight: 18,
      itemsSpacing: 8,
      symbolSize: 9,
    },
  };
}

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

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  fallback: Values[number],
): Values[number] {
  return typeof value === "string" && values.includes(value)
    ? value as Values[number]
    : fallback;
}

function normalizeMargin(value: unknown, fallback: ChartMarginConfig): ChartMarginConfig {
  const candidate = record(value);
  return {
    top: finiteNumber(candidate.top, fallback.top, 0, 500),
    right: finiteNumber(candidate.right, fallback.right, 0, 500),
    bottom: finiteNumber(candidate.bottom, fallback.bottom, 0, 500),
    left: finiteNumber(candidate.left, fallback.left, 0, 500),
  };
}

function normalizeAxis(value: unknown, fallback: ChartAxisDebugConfig): ChartAxisDebugConfig {
  const candidate = record(value);
  return {
    showLegend: booleanValue(candidate.showLegend, fallback.showLegend),
    tickSize: finiteNumber(candidate.tickSize, fallback.tickSize, 0, 40),
    tickPadding: finiteNumber(candidate.tickPadding, fallback.tickPadding, 0, 80),
    tickRotation: finiteNumber(candidate.tickRotation, fallback.tickRotation, -90, 90),
    truncateTickAt: finiteNumber(candidate.truncateTickAt, fallback.truncateTickAt, 0, 100),
    legendOffset: finiteNumber(candidate.legendOffset, fallback.legendOffset, -500, 500),
  };
}

function normalizeLegend(value: unknown, fallback: ChartLegendDebugConfig): ChartLegendDebugConfig {
  const candidate = record(value);
  return {
    enabled: booleanValue(candidate.enabled, fallback.enabled),
    anchor: enumValue(candidate.anchor, LEGEND_ANCHORS, fallback.anchor),
    direction: enumValue(candidate.direction, ["column", "row"] as const, fallback.direction),
    translateX: finiteNumber(candidate.translateX, fallback.translateX, -500, 500),
    translateY: finiteNumber(candidate.translateY, fallback.translateY, -500, 500),
    itemWidth: finiteNumber(candidate.itemWidth, fallback.itemWidth, 20, 500),
    itemHeight: finiteNumber(candidate.itemHeight, fallback.itemHeight, 10, 100),
    itemsSpacing: finiteNumber(candidate.itemsSpacing, fallback.itemsSpacing, 0, 80),
    symbolSize: finiteNumber(candidate.symbolSize, fallback.symbolSize, 2, 48),
  };
}

export function normalizeChartDebugConfig(
  value: unknown,
  fallback: NivoChartDebugConfig,
): NivoChartDebugConfig {
  const candidate = record(value);
  if (fallback.chartType === "line") {
    const scale = record(candidate.yScale);
    return {
      chartType: "line",
      height: finiteNumber(candidate.height, fallback.height, 220, 900),
      maxXTicks: finiteNumber(candidate.maxXTicks, fallback.maxXTicks, 2, 40),
      margin: normalizeMargin(candidate.margin, fallback.margin),
      yScale: {
        min: candidate.yScale && scale.min === 0 ? 0 : fallback.yScale.min,
        max: "auto",
        stacked: booleanValue(scale.stacked, fallback.yScale.stacked),
        reverse: booleanValue(scale.reverse, fallback.yScale.reverse),
      },
      curve: enumValue(candidate.curve, LINE_CURVES, fallback.curve),
      lineWidth: finiteNumber(candidate.lineWidth, fallback.lineWidth, 1, 12),
      enableArea: booleanValue(candidate.enableArea, fallback.enableArea),
      areaOpacity: finiteNumber(candidate.areaOpacity, fallback.areaOpacity, 0, 1),
      enableGridX: booleanValue(candidate.enableGridX, fallback.enableGridX),
      enableGridY: booleanValue(candidate.enableGridY, fallback.enableGridY),
      enablePoints: booleanValue(candidate.enablePoints, fallback.enablePoints),
      pointSize: finiteNumber(candidate.pointSize, fallback.pointSize, 0, 40),
      pointBorderWidth: finiteNumber(candidate.pointBorderWidth, fallback.pointBorderWidth, 0, 12),
      enableTouchCrosshair: booleanValue(candidate.enableTouchCrosshair, fallback.enableTouchCrosshair),
      useMesh: booleanValue(candidate.useMesh, fallback.useMesh),
      axisBottom: normalizeAxis(candidate.axisBottom, fallback.axisBottom),
      axisLeft: normalizeAxis(candidate.axisLeft, fallback.axisLeft),
      legend: normalizeLegend(candidate.legend, fallback.legend),
    };
  }

  return {
    chartType: "bar",
    height: finiteNumber(candidate.height, fallback.height, 220, 900),
    margin: normalizeMargin(candidate.margin, fallback.margin),
    layout: enumValue(candidate.layout, ["horizontal", "vertical"] as const, fallback.layout),
    groupMode: enumValue(candidate.groupMode, ["grouped", "stacked"] as const, fallback.groupMode),
    padding: finiteNumber(candidate.padding, fallback.padding, 0, 0.95),
    innerPadding: finiteNumber(candidate.innerPadding, fallback.innerPadding, 0, 40),
    borderRadius: finiteNumber(candidate.borderRadius, fallback.borderRadius, 0, 30),
    borderWidth: finiteNumber(candidate.borderWidth, fallback.borderWidth, 0, 10),
    enableGridX: booleanValue(candidate.enableGridX, fallback.enableGridX),
    enableGridY: booleanValue(candidate.enableGridY, fallback.enableGridY),
    enableLabel: booleanValue(candidate.enableLabel, fallback.enableLabel),
    labelSkipWidth: finiteNumber(candidate.labelSkipWidth, fallback.labelSkipWidth, 0, 200),
    labelSkipHeight: finiteNumber(candidate.labelSkipHeight, fallback.labelSkipHeight, 0, 200),
    axisBottom: normalizeAxis(candidate.axisBottom, fallback.axisBottom),
    axisLeft: normalizeAxis(candidate.axisLeft, fallback.axisLeft),
    legend: normalizeLegend(candidate.legend, fallback.legend),
  };
}

function exportAxis(axis: ChartAxisDebugConfig, derivedLegend: string) {
  return {
    tickSize: axis.tickSize,
    tickPadding: axis.tickPadding,
    tickRotation: axis.tickRotation,
    truncateTickAt: axis.truncateTickAt || null,
    legend: axis.showLegend ? derivedLegend : null,
    legendOffset: axis.legendOffset,
  };
}

function exportLegend(legend: ChartLegendDebugConfig) {
  return legend.enabled ? [{
    anchor: legend.anchor,
    direction: legend.direction,
    translateX: legend.translateX,
    translateY: legend.translateY,
    itemWidth: legend.itemWidth,
    itemHeight: legend.itemHeight,
    itemsSpacing: legend.itemsSpacing,
    symbolSize: legend.symbolSize,
    symbolShape: "circle",
  }] : [];
}

export function serializeNivoChartDebugConfig(config: NivoChartDebugConfig): string {
  if (config.chartType === "line") {
    return JSON.stringify({
      component: "ResponsiveLine",
      wrapper: { height: config.height, maxXTicks: config.maxXTicks },
      props: {
        margin: config.margin,
        yScale: config.yScale,
        curve: config.curve,
        lineWidth: config.lineWidth,
        enableArea: config.enableArea,
        areaOpacity: config.areaOpacity,
        enableGridX: config.enableGridX,
        enableGridY: config.enableGridY,
        enablePoints: config.enablePoints,
        pointSize: config.pointSize,
        pointBorderWidth: config.pointBorderWidth,
        enableTouchCrosshair: config.enableTouchCrosshair,
        useMesh: config.useMesh,
        axisBottom: exportAxis(config.axisBottom, "<data-derived x-axis title>"),
        axisLeft: exportAxis(config.axisLeft, "<data-derived y-axis title>"),
        legends: exportLegend(config.legend),
      },
    }, null, 2);
  }

  return JSON.stringify({
    component: "ResponsiveBar",
    wrapper: { height: config.height },
    props: {
      margin: config.margin,
      layout: config.layout,
      groupMode: config.groupMode,
      padding: config.padding,
      innerPadding: config.innerPadding,
      borderRadius: config.borderRadius,
      borderWidth: config.borderWidth,
      enableGridX: config.enableGridX,
      enableGridY: config.enableGridY,
      enableLabel: config.enableLabel,
      labelSkipWidth: config.labelSkipWidth,
      labelSkipHeight: config.labelSkipHeight,
      axisBottom: exportAxis(config.axisBottom, "<data-derived bottom-axis title>"),
      axisLeft: exportAxis(config.axisLeft, "<data-derived left-axis title>"),
      legends: exportLegend(config.legend),
    },
  }, null, 2);
}
