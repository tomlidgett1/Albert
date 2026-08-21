/**
 * Browser / Node helper. Do not import this from the Vinext worker
 * (API routes or RSC). Flint is safe; Vega is not.
 */
import { assembleVegaLite, type ChartAssemblyInput } from "flint-chart";

export type FlintAppearance = "light" | "dark";

export type AssemblableFlintPlan = Readonly<{
  semantic_types: Readonly<Record<string, unknown>>;
  field_display_names?: Readonly<Record<string, string>>;
  chart_spec: Readonly<{
    chartType: string;
    title: string;
    subtitle: string;
    encodings: Readonly<Record<string, unknown>>;
    chartProperties?: Readonly<Record<string, unknown>>;
  }>;
  data: readonly Readonly<Record<string, unknown>>[];
}>;

export type FlintThemeTokens = Readonly<{
  canvas: string;
  ink: string;
  muted: string;
  grid: string;
  palette: readonly string[];
}>;

const LIGHT_TOKENS: FlintThemeTokens = {
  canvas: "#ffffff",
  ink: "#161719",
  muted: "#6b6e76",
  grid: "rgba(35, 36, 38, 0.08)",
  palette: ["#60753a", "#376f91", "#815a91", "#a45f32"],
};

const DARK_TOKENS: FlintThemeTokens = {
  canvas: "#1b1d20",
  ink: "#f5f6f8",
  muted: "#a8abb4",
  grid: "rgba(231, 233, 238, 0.09)",
  palette: ["#b8e35a", "#79c5f2", "#d3a0e5", "#f2a66f"],
};

export function flintThemeTokens(appearance: FlintAppearance, override?: Partial<FlintThemeTokens>): FlintThemeTokens {
  const base = appearance === "dark" ? DARK_TOKENS : LIGHT_TOKENS;
  return {
    canvas: override?.canvas || base.canvas,
    ink: override?.ink || base.ink,
    muted: override?.muted || base.muted,
    grid: override?.grid || base.grid,
    palette: override?.palette?.length ? override.palette : base.palette,
  };
}

export type FlintAssembleOptions = Readonly<{
  width?: number;
  height?: number;
  tokens?: Partial<FlintThemeTokens>;
  /**
   * Chat and playground cards already name the chart. Flint's Swiss headline
   * would steal plot height and grow the SVG past the card, so omit it.
   */
  cardFrame?: boolean;
}>;

export function albertFlintTheme(appearance: FlintAppearance, tokens?: Partial<FlintThemeTokens>): Record<string, unknown> {
  const next = flintThemeTokens(appearance, tokens);
  return {
    extends: appearance === "dark" ? "powerbi" : "swiss",
    id: appearance === "dark" ? "albert-dash-dark" : "albert-dash-light",
    ink: {
      surface: {
        source: "host",
        canvas: next.canvas,
        plot: next.canvas,
      },
      text: { primary: next.ink, secondary: next.muted, muted: next.muted },
      structure: { grid: next.grid, axis: next.muted },
      series: {
        single: next.palette[0],
        categorical: [...next.palette],
      },
    },
    marks: {
      point: {
        presence: "full",
        size: 52,
        fill: "solid",
        halo: { presence: "hairline", width: 1.5 },
      },
    },
    chartDefaults: {
      "Line Chart": { showPoints: true },
    },
  };
}

/**
 * Vega expressions cannot use Cube keys as object keys. `tooltip: true` builds
 * `{"sales_analytics.gross_takings": …, "sales_analytics\.gross_takings": …}`
 * and the backslash fails to parse. `__` is the same name, legal in Vega.
 */
export function vegaSafeField(field: string): string {
  return field.replaceAll(".", "__");
}

function rewriteKeyedRecord<T>(record: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined {
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [vegaSafeField(key), value]));
}

function rewriteEncodingFields(encodings: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [channel, encoding] of Object.entries(encodings)) {
    next[channel] = isRecord(encoding) && typeof encoding.field === "string"
      ? { ...encoding, field: vegaSafeField(encoding.field) }
      : encoding;
  }
  return next;
}

export function toAssemblyInput(
  plan: AssemblableFlintPlan,
  appearance: FlintAppearance,
  options?: FlintAssembleOptions,
): ChartAssemblyInput {
  const width = options?.width ?? 720;
  const height = options?.height ?? 400;
  const cardFrame = options?.cardFrame !== false;
  return {
    data: { values: plan.data.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [vegaSafeField(key), value]))) },
    semantic_types: rewriteKeyedRecord(plan.semantic_types) ?? {},
    ...(plan.field_display_names ? { field_display_names: rewriteKeyedRecord(plan.field_display_names) } : {}),
    theme_spec: albertFlintTheme(appearance, options?.tokens),
    chart_spec: {
      chartType: plan.chart_spec.chartType,
      title: cardFrame ? "" : plan.chart_spec.title,
      subtitle: cardFrame ? "" : plan.chart_spec.subtitle,
      encodings: rewriteEncodingFields(plan.chart_spec.encodings),
      baseSize: { width, height },
      canvasSize: { width, height },
      chartProperties: {
        ...(plan.chart_spec.chartType === "Line Chart" ? { showPoints: true } : {}),
        ...(plan.chart_spec.chartProperties ?? {}),
      },
    },
    options: { addTooltips: true },
  } as ChartAssemblyInput;
}

/**
 * Paint the spec for a card. Leave Vega's default pad autosize alone: width
 * and height are the plot, axes stay outside it, and the browser scales the
 * finished SVG to the card. Do not clip or force-fit here.
 */
export function paintAssembledSpec(
  spec: Record<string, unknown>,
  tokens: Readonly<{ canvas: string; ink: string }>,
  plan: AssemblableFlintPlan,
  plotWidth: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...spec };
  next.background = tokens.canvas;
  next.title = null;
  next.autosize = { type: "pad" };
  const config = isRecord(spec.config) ? { ...spec.config } : {};
  const view = isRecord(config.view) ? { ...config.view } : {};
  view.fill = tokens.canvas;
  view.stroke = null;
  delete view.clip;
  config.view = view;
  config.background = tokens.canvas;
  next.config = config;
  preserveCategoryDomainOrder(next, plan);
  if (plan.chart_spec.chartType === "Line Chart") {
    labelLinePointValues(next, plan, tokens.ink, plotWidth);
  }
  return next;
}

function firstSeenValues(rows: readonly Readonly<Record<string, unknown>>[], field: string): unknown[] {
  const order: unknown[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined || value === "") continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    order.push(value);
  }
  return order;
}

function applyCategorySort(encoding: Record<string, unknown>, field: string, order: unknown[]): void {
  const channel = encoding[field];
  if (!isRecord(channel)) return;
  if (channel.type === "temporal" || channel.type === "quantitative") return;
  encoding[field] = { ...channel, sort: order };
}

/** Keep month-of-year overlays (Aug, Sep, …) in data order, not A–Z. */
export function preserveCategoryDomainOrder(
  spec: Record<string, unknown>,
  plan: AssemblableFlintPlan,
): void {
  const body = isRecord(spec.spec) ? spec.spec : spec;
  const encodings = positionalEncodings(body);
  const xField = encodingField(encodings.x);
  if (!xField) return;
  const rows = sourceValueRows(spec)[0] ?? [...plan.data];
  const order = firstSeenValues(rows, rowFieldName(xField));
  if (order.length < 2) return;
  if (isRecord(body.encoding)) applyCategorySort(body.encoding, "x", order);
  if (Array.isArray(body.layer)) {
    body.layer = body.layer.map((layer) => {
      if (!isRecord(layer) || !isRecord(layer.encoding)) return layer;
      const next = { ...layer, encoding: { ...layer.encoding } };
      applyCategorySort(next.encoding, "x", order);
      return next;
    });
  }
}

const POINT_LABEL_FIELD = "__albert_value_label";
const POINT_LABEL_GAP_PX = 44;

function encodingField(encoding: unknown): string | undefined {
  return isRecord(encoding) && typeof encoding.field === "string" ? encoding.field : undefined;
}

/** Flint/Vega-Lite write `a\\.b` in encodings; the row key is still `a.b`. */
function rowFieldName(field: string): string {
  return field.replaceAll("\\.", ".");
}

function encodingType(encoding: unknown): string | undefined {
  return isRecord(encoding) && typeof encoding.type === "string" ? encoding.type : undefined;
}

function positionalEncodings(body: Record<string, unknown>): { x?: unknown; y?: unknown; color?: unknown } {
  if (isRecord(body.encoding)) return body.encoding;
  if (Array.isArray(body.layer)) {
    for (const layer of body.layer) {
      if (isRecord(layer) && isRecord(layer.encoding) && encodingField(layer.encoding.x) && encodingField(layer.encoding.y)) {
        return layer.encoding;
      }
    }
  }
  return {};
}

function semanticKind(value: unknown): { type?: string; unit?: string } {
  if (typeof value === "string") return { type: value };
  if (isRecord(value) && typeof value.semanticType === "string") {
    return { type: value.semanticType, unit: typeof value.unit === "string" ? value.unit : undefined };
  }
  return {};
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function trimFloat(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

/**
 * Format a point label in JavaScript. Vega-Lite calculate expressions escape
 * dots inside `datum["a.b"]`, so Cube keys become a missing field and print
 * NaN. The tooltip still works because encodings keep the real field name.
 */
export function formatPointValue(value: unknown, semantic: unknown): string | null {
  const n = numericValue(value);
  if (n === null) return null;
  const { type, unit } = semanticKind(semantic);
  if (type === "Percentage") {
    return Math.abs(n) <= 1.5 ? `${(n * 100).toFixed(1)}%` : `${n.toFixed(1)}%`;
  }
  if (type === "Count") {
    return String(Math.round(n));
  }
  const money = type === "Price" || type === "Amount";
  const prefix = money
    ? (unit === "USD" ? "US$" : !unit || unit === "AUD" ? "A$" : `${unit} `)
    : "";
  if (Math.abs(n) >= 1_000_000_000) return `${prefix}${trimFloat(n / 1_000_000_000)}G`;
  if (Math.abs(n) >= 1_000_000) return `${prefix}${trimFloat(n / 1_000_000)}M`;
  if (Math.abs(n) >= 1000) return `${prefix}${trimFloat(n / 1000)}k`;
  if (money) return `${prefix}${n.toFixed(2)}`;
  return trimFloat(n);
}

function labelStep(pointsPerSeries: number, plotWidth: number): number {
  if (pointsPerSeries <= 1) return 1;
  const spacing = plotWidth / pointsPerSeries;
  return Math.max(1, Math.round(POINT_LABEL_GAP_PX / Math.max(spacing, 1)));
}

function sourceValueRows(spec: Record<string, unknown>): Array<Record<string, unknown>>[] {
  const bags: Array<Record<string, unknown>>[] = [];
  const seen = new Set<unknown>();
  const take = (data: unknown) => {
    if (!isRecord(data) || !Array.isArray(data.values) || seen.has(data.values)) return;
    seen.add(data.values);
    bags.push(data.values as Array<Record<string, unknown>>);
  };
  take(spec.data);
  if (isRecord(spec.spec)) take(spec.spec.data);
  return bags;
}

function stampPointLabels(
  rows: Array<Record<string, unknown>>,
  measureField: string,
  seriesField: string | undefined,
  semantic: unknown,
  plotWidth: number,
): void {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const key = seriesField ? String(row[seriesField] ?? "") : "";
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const step = labelStep(list.length, plotWidth);
    const numbers = list.map((row) => numericValue(row[measureField]));
    const finite = numbers.filter((value): value is number => value !== null);
    const min = finite.length ? Math.min(...finite) : null;
    const max = finite.length ? Math.max(...finite) : null;
    list.forEach((row, index) => {
      const n = numbers[index];
      const keep = n !== null && (
        step <= 1
        || index === 0
        || index === list.length - 1
        || index % step === 0
        || n === min
        || n === max
      );
      row[POINT_LABEL_FIELD] = keep ? formatPointValue(n, semantic) ?? "" : "";
    });
  }
}

export function labelLinePointValues(
  spec: Record<string, unknown>,
  plan: AssemblableFlintPlan,
  ink: string,
  plotWidth: number,
): void {
  const body = isRecord(spec.spec) ? spec.spec : spec;
  const encodings = positionalEncodings(body);
  const xField = encodingField(encodings.x);
  const yField = encodingField(encodings.y);
  if (!xField || !yField) return;
  const measureField = rowFieldName(encodingType(encodings.y) === "quantitative"
    ? yField
    : encodingType(encodings.x) === "quantitative" ? xField : yField);
  const seriesField = encodingField(encodings.color);
  const seriesRowField = seriesField ? rowFieldName(seriesField) : undefined;
  const semantic = plan.semantic_types[measureField]
    ?? Object.entries(plan.semantic_types).find(([key]) => vegaSafeField(key) === measureField)?.[1];
  const bags = sourceValueRows(spec);
  if (bags.length === 0) {
    const rows = plan.data.map((row) => ({ ...row }));
    stampPointLabels(rows, measureField, seriesRowField, semantic, plotWidth);
    body.data = { values: rows };
  } else {
    for (const rows of bags) stampPointLabels(rows, measureField, seriesRowField, semantic, plotWidth);
  }
  const labelLayer = {
    mark: {
      type: "text",
      align: "center",
      baseline: "bottom",
      dy: -11,
      fontSize: 10,
      fontWeight: 550,
      fill: ink,
      tooltip: null,
    },
    transform: [{ filter: `datum[${JSON.stringify(POINT_LABEL_FIELD)}] !== ''` }],
    encoding: {
      x: isRecord(encodings.x) ? { field: encodings.x.field, type: encodings.x.type } : undefined,
      y: isRecord(encodings.y) ? { field: encodings.y.field, type: encodings.y.type } : undefined,
      text: { field: POINT_LABEL_FIELD, type: "nominal" },
    },
  };
  if (Array.isArray(body.layer)) {
    body.layer = [...body.layer, labelLayer];
    return;
  }
  if (body.mark) {
    body.layer = [{ mark: body.mark }, labelLayer];
    delete body.mark;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripPrivate(spec: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(spec).filter(([key]) => !key.startsWith("_")));
}

function readWarnings(spec: Record<string, unknown>): readonly string[] {
  const raw = spec._warnings;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (isRecord(item) && typeof item.message === "string" && item.message.trim()) {
      return [item.message.trim()];
    }
    return [];
  });
}

export function assembleFlintChart(
  plan: AssemblableFlintPlan,
  appearance: FlintAppearance,
  options?: FlintAssembleOptions,
): { spec: Record<string, unknown>; warnings: readonly string[] } {
  let assembled: Record<string, unknown>;
  try {
    assembled = assembleVegaLite(toAssemblyInput(plan, appearance, options)) as Record<string, unknown>;
  } catch {
    assembled = assembleVegaLite(toAssemblyInput(plan, "light", options)) as Record<string, unknown>;
  }
  const tokens = flintThemeTokens(appearance, options?.tokens);
  const spec = options?.cardFrame === false
    ? stripPrivate(assembled)
    : paintAssembledSpec(stripPrivate(assembled), tokens, plan, options?.width ?? 720);
  return {
    spec,
    warnings: readWarnings(assembled),
  };
}

export function assembleFlintSpec(
  plan: AssemblableFlintPlan,
  appearance: FlintAppearance,
): Record<string, unknown> {
  return assembleFlintChart(plan, appearance).spec;
}
