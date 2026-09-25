"use client";

import { ResponsiveBar, type BarLegendProps } from "@nivo/bar";
import type { LegendProps } from "@nivo/legends";
import { ResponsiveLine } from "@nivo/line";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AXIS_LEGEND_POSITIONS,
  BAR_COLOR_BY,
  BAR_GROUP_MODES,
  BAR_LABEL_POSITIONS,
  BAR_LAYERS,
  BAR_LAYOUTS,
  BLEND_MODES,
  COLOR_MODES,
  COLOR_MODIFIERS,
  CROSSHAIR_TYPES,
  DEFAULT_NIVO_CHART_DESIGN,
  INHERITED_COLOR_KINDS,
  LAYOUT_MODES,
  LEGEND_ANCHORS,
  LEGEND_DIRECTIONS,
  LEGEND_ITEM_DIRECTIONS,
  LEGEND_SYMBOL_SHAPES,
  LINE_CURVES,
  LINE_LAYERS,
  LINE_X_SCALE_TYPES,
  LINE_Y_SCALE_TYPES,
  MOTION_PRESETS,
  NIVO_COLOR_SCHEMES,
  SLICE_MODES,
  VALUE_SCALE_TYPES,
  axisToNivo,
  barDesignToNivoProps,
  legendToNivo,
  lineDesignToNivoProps,
  normalizeNivoChartDesign,
  type AxisDesign,
  type InheritedColorDesign,
  type LegendDesign,
  type MotionDesign,
  type NivoChartDesign,
} from "@/packages/shared/src";
import { publishNivoChartDesign, reloadPublishedNivoChartDesign } from "../lib/nivo-chart-design-store";
import styles from "./chart-design.module.css";

type StudioTab = "bar" | "line" | "theme" | "json";

const STUDIO_TABS = [
  { key: "bar" as const, label: "Bar chart" },
  { key: "line" as const, label: "Line chart" },
  { key: "theme" as const, label: "Theme" },
  { key: "json" as const, label: "JSON" },
];

const PREVIEW_BAR = [
  { period: "Jan", Sales: 18400, Costs: 11200 },
  { period: "Feb", Sales: 22100, Costs: 12800 },
  { period: "Mar", Sales: 19800, Costs: 12100 },
  { period: "Apr", Sales: 24600, Costs: 13900 },
  { period: "May", Sales: 27300, Costs: 14800 },
  { period: "Jun", Sales: 25100, Costs: 14100 },
];

const PREVIEW_LINE = [
  {
    id: "Sales",
    data: PREVIEW_BAR.map((row) => ({ x: row.period, y: row.Sales })),
  },
  {
    id: "Costs",
    data: PREVIEW_BAR.map((row) => ({ x: row.period, y: row.Costs })),
  },
];

function setAt<T>(source: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const draft = structuredClone(source) as Record<string, unknown>;
  let cursor: Record<string, unknown> = draft;
  for (const key of keys.slice(0, -1)) {
    const next = cursor[key];
    if (!next || typeof next !== "object") return source;
    cursor = next as Record<string, unknown>;
  }
  cursor[keys.at(-1)!] = value;
  return draft as T;
}

function hexForPicker(value: string): string | null {
  const match = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/iu);
  if (!match) return null;
  const raw = match[1]!;
  if (raw.length === 3) {
    return `#${raw.split("").map((part) => `${part}${part}`).join("")}`;
  }
  return `#${raw}`;
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input type="text" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    </label>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={styles.toggle}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const picker = hexForPicker(value);
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <div className={styles.colorRow}>
        {picker ? (
          <input type="color" value={picker} onChange={(event) => onChange(event.currentTarget.value)} aria-label={`${label} picker`} />
        ) : null}
        <input type="text" value={value} onChange={(event) => onChange(event.currentTarget.value)} />
      </div>
    </label>
  );
}

function InheritedColorFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: InheritedColorDesign;
  onChange: (value: InheritedColorDesign) => void;
}) {
  const modifier = value.modifiers[0] ?? (["darker", 0] as const);
  return (
    <div className={styles.grid}>
      <SelectField
        label={`${label} kind`}
        value={value.kind}
        options={INHERITED_COLOR_KINDS}
        onChange={(kind) => onChange({ ...value, kind: kind as InheritedColorDesign["kind"] })}
      />
      <ColorField label={`${label} value`} value={value.value} onChange={(next) => onChange({ ...value, value: next })} />
      <SelectField
        label={`${label} modifier`}
        value={modifier[0]}
        options={COLOR_MODIFIERS}
        onChange={(name) => onChange({ ...value, modifiers: [[name, modifier[1]]] })}
      />
      <NumberField
        label={`${label} modifier amount`}
        value={modifier[1]}
        min={-4}
        max={4}
        step={0.05}
        onChange={(amount) => onChange({ ...value, modifiers: [[modifier[0], amount]] })}
      />
    </div>
  );
}

function AxisFields({
  title,
  axis,
  onChange,
}: {
  title: string;
  axis: AxisDesign;
  onChange: (axis: AxisDesign) => void;
}) {
  return (
    <Section title={title}>
      <div className={styles.grid}>
        <ToggleField label="Enabled" checked={axis.enabled} onChange={(enabled) => onChange({ ...axis, enabled })} />
        <ToggleField label="Show axis title" checked={axis.showLegend} onChange={(showLegend) => onChange({ ...axis, showLegend })} />
        <NumberField label="Tick size" value={axis.tickSize} min={0} max={40} onChange={(tickSize) => onChange({ ...axis, tickSize })} />
        <NumberField label="Tick padding" value={axis.tickPadding} min={0} max={80} onChange={(tickPadding) => onChange({ ...axis, tickPadding })} />
        <NumberField label="Tick rotation" value={axis.tickRotation} min={-90} max={90} onChange={(tickRotation) => onChange({ ...axis, tickRotation })} />
        <NumberField label="Truncate at (0 = off)" value={axis.truncateTickAt} min={0} max={200} onChange={(truncateTickAt) => onChange({ ...axis, truncateTickAt })} />
        <NumberField label="Title offset" value={axis.legendOffset} min={-500} max={500} onChange={(legendOffset) => onChange({ ...axis, legendOffset })} />
        <SelectField
          label="Title position"
          value={axis.legendPosition}
          options={AXIS_LEGEND_POSITIONS}
          onChange={(legendPosition) => onChange({ ...axis, legendPosition: legendPosition as AxisDesign["legendPosition"] })}
        />
        <TextField label="Tick values (count or comma list)" value={axis.tickValues} onChange={(tickValues) => onChange({ ...axis, tickValues })} />
      </div>
    </Section>
  );
}

function LegendFields({
  legend,
  onChange,
  includeDataFrom = false,
}: {
  legend: LegendDesign;
  onChange: (legend: LegendDesign) => void;
  includeDataFrom?: boolean;
}) {
  return (
    <Section title="Legend">
      <div className={styles.grid}>
        <ToggleField label="Show legend" checked={legend.enabled} onChange={(enabled) => onChange({ ...legend, enabled })} />
        {includeDataFrom ? (
          <SelectField
            label="Data from"
            value={legend.dataFrom}
            options={["keys", "indexes"]}
            onChange={(dataFrom) => onChange({ ...legend, dataFrom: dataFrom as LegendDesign["dataFrom"] })}
          />
        ) : null}
        <SelectField label="Anchor" value={legend.anchor} options={LEGEND_ANCHORS} onChange={(anchor) => onChange({ ...legend, anchor: anchor as LegendDesign["anchor"] })} />
        <SelectField label="Direction" value={legend.direction} options={LEGEND_DIRECTIONS} onChange={(direction) => onChange({ ...legend, direction: direction as LegendDesign["direction"] })} />
        <SelectField label="Item direction" value={legend.itemDirection} options={LEGEND_ITEM_DIRECTIONS} onChange={(itemDirection) => onChange({ ...legend, itemDirection: itemDirection as LegendDesign["itemDirection"] })} />
        <SelectField label="Symbol shape" value={legend.symbolShape} options={LEGEND_SYMBOL_SHAPES} onChange={(symbolShape) => onChange({ ...legend, symbolShape: symbolShape as LegendDesign["symbolShape"] })} />
        <NumberField label="Translate X" value={legend.translateX} min={-500} max={500} onChange={(translateX) => onChange({ ...legend, translateX })} />
        <NumberField label="Translate Y" value={legend.translateY} min={-500} max={500} onChange={(translateY) => onChange({ ...legend, translateY })} />
        <NumberField label="Item width" value={legend.itemWidth} min={20} max={500} onChange={(itemWidth) => onChange({ ...legend, itemWidth })} />
        <NumberField label="Item height" value={legend.itemHeight} min={10} max={120} onChange={(itemHeight) => onChange({ ...legend, itemHeight })} />
        <NumberField label="Item spacing" value={legend.itemsSpacing} min={0} max={80} onChange={(itemsSpacing) => onChange({ ...legend, itemsSpacing })} />
        <NumberField label="Item opacity" value={legend.itemOpacity} min={0} max={1} step={0.05} onChange={(itemOpacity) => onChange({ ...legend, itemOpacity })} />
        <NumberField label="Symbol size" value={legend.symbolSize} min={2} max={48} onChange={(symbolSize) => onChange({ ...legend, symbolSize })} />
        <NumberField label="Symbol spacing" value={legend.symbolSpacing} min={0} max={40} onChange={(symbolSpacing) => onChange({ ...legend, symbolSpacing })} />
        <NumberField label="Symbol border width" value={legend.symbolBorderWidth} min={0} max={12} onChange={(symbolBorderWidth) => onChange({ ...legend, symbolBorderWidth })} />
        <ColorField label="Item text colour" value={legend.itemTextColor} onChange={(itemTextColor) => onChange({ ...legend, itemTextColor })} />
        <ColorField label="Item background" value={legend.itemBackground} onChange={(itemBackground) => onChange({ ...legend, itemBackground })} />
        <ColorField label="Symbol border colour" value={legend.symbolBorderColor} onChange={(symbolBorderColor) => onChange({ ...legend, symbolBorderColor })} />
        <ToggleField label="Justify" checked={legend.justify} onChange={(justify) => onChange({ ...legend, justify })} />
        <ToggleField label="Toggle series" checked={legend.toggleSerie} onChange={(toggleSerie) => onChange({ ...legend, toggleSerie })} />
      </div>
    </Section>
  );
}

function MotionFields({
  motion,
  onChange,
}: {
  motion: MotionDesign;
  onChange: (motion: MotionDesign) => void;
}) {
  return (
    <Section title="Motion">
      <div className={styles.grid}>
        <SelectField
          label="Motion config"
          value={motion.preset}
          options={[...MOTION_PRESETS, "custom"]}
          onChange={(preset) => onChange({ ...motion, preset: preset as MotionDesign["preset"] })}
        />
        <NumberField label="Mass" value={motion.mass} min={0.1} max={20} step={0.1} onChange={(mass) => onChange({ ...motion, mass })} />
        <NumberField label="Tension" value={motion.tension} min={1} max={800} onChange={(tension) => onChange({ ...motion, tension })} />
        <NumberField label="Friction" value={motion.friction} min={1} max={200} onChange={(friction) => onChange({ ...motion, friction })} />
        <ToggleField label="Clamp" checked={motion.clamp} onChange={(clamp) => onChange({ ...motion, clamp })} />
      </div>
    </Section>
  );
}

function LayerFields({
  layers,
  options,
  onChange,
}: {
  layers: readonly string[];
  options: readonly string[];
  onChange: (layers: readonly string[]) => void;
}) {
  return (
    <Section title="Layers">
      <div className={styles.layers}>
        {options.map((layer) => {
          const pressed = layers.includes(layer);
          return (
            <button
              type="button"
              key={layer}
              aria-pressed={pressed}
              onClick={() => onChange(pressed ? layers.filter((item) => item !== layer) : [...layers, layer])}
            >
              {layer}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={styles.section}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function ChartPreview({ design, tab }: { design: NivoChartDesign; tab: StudioTab }) {
  const barProps = barDesignToNivoProps(design);
  const lineProps = lineDesignToNivoProps(design);
  const previewKind = tab === "line" ? "line" : "bar";
  const height = previewKind === "line" ? design.line.height : design.bar.height;

  return (
    <div className={styles.previewCanvas}>
      <div className={styles.previewChart} style={{ height }}>
        {previewKind === "bar" ? (
          <ResponsiveBar
            {...(barProps as object)}
            data={PREVIEW_BAR}
            keys={["Sales", "Costs"]}
            indexBy="period"
            axisBottom={axisToNivo(design.bar.axisBottom, "Period")}
            axisLeft={axisToNivo(design.bar.axisLeft, "Amount")}
            axisTop={axisToNivo(design.bar.axisTop, "Period")}
            axisRight={axisToNivo(design.bar.axisRight, "Amount")}
            legends={design.bar.legend.enabled
              ? [legendToNivo(design.bar.legend, design.bar.legend.dataFrom) as unknown as BarLegendProps]
              : []}
          />
        ) : (
          <ResponsiveLine
            {...(lineProps as object)}
            data={PREVIEW_LINE}
            axisBottom={axisToNivo(design.line.axisBottom, "Period")}
            axisLeft={axisToNivo(design.line.axisLeft, "Amount")}
            axisTop={axisToNivo(design.line.axisTop, "Period")}
            axisRight={axisToNivo(design.line.axisRight, "Amount")}
            legends={design.line.legend.enabled
              ? [legendToNivo(design.line.legend) as unknown as LegendProps]
              : []}
          />
        )}
      </div>
    </div>
  );
}

export default function ChartDesignStudio({ refreshToken = 0 }: { refreshToken?: number }) {
  const [design, setDesign] = useState<NivoChartDesign>(DEFAULT_NIVO_CHART_DESIGN);
  const [savedSignature, setSavedSignature] = useState("");
  const [tab, setTab] = useState<StudioTab>("bar");
  const [jsonText, setJsonText] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const tabRefs = useRef<Record<StudioTab, HTMLButtonElement | null>>({
    bar: null,
    line: null,
    theme: null,
    json: null,
  });
  const tabRowRef = useRef<HTMLDivElement | null>(null);
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });

  const load = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/admin/chart-design", { cache: "no-store" });
      const payload = await response.json() as { design?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "The chart design could not be loaded.");
      const next = normalizeNivoChartDesign(payload.design);
      setDesign(next);
      setSavedSignature(JSON.stringify(next));
      setJsonText(JSON.stringify(next, null, 2));
      publishNivoChartDesign(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The chart design could not be loaded.");
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void load());
  }, [load, refreshToken]);

  useLayoutEffect(() => {
    const button = tabRefs.current[tab];
    const row = tabRowRef.current;
    if (!button || !row) return;
    const rowBox = row.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    setTabIndicator({ left: buttonBox.left - rowBox.left, width: buttonBox.width });
  }, [tab, design]);

  const dirty = JSON.stringify(design) !== savedSignature;

  const update = (path: string, value: unknown) => {
    const next = normalizeNivoChartDesign(setAt(design, path, value));
    setDesign(next);
    setJsonText(JSON.stringify(next, null, 2));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/admin/chart-design", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design }),
      });
      const payload = await response.json() as { design?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "The chart design could not be saved.");
      const next = normalizeNivoChartDesign(payload.design ?? design);
      setDesign(next);
      setSavedSignature(JSON.stringify(next));
      setJsonText(JSON.stringify(next, null, 2));
      publishNivoChartDesign(next);
      setStatus("Saved as the Albert default. Chat on localhost and production will use this design.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The chart design could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    const next = DEFAULT_NIVO_CHART_DESIGN;
    setDesign(next);
    setJsonText(JSON.stringify(next, null, 2));
    setStatus("Restored the shipped Albert defaults. Save to publish them.");
  };

  const applyJson = () => {
    try {
      const next = normalizeNivoChartDesign(JSON.parse(jsonText));
      setDesign(next);
      setJsonText(JSON.stringify(next, null, 2));
      setError("");
      setStatus("JSON applied to the live preview. Save to publish.");
    } catch {
      setError("The JSON is invalid. Fix it, then apply again.");
    }
  };

  const theme = design.theme;
  const docsUrl = tab === "line" ? "https://nivo.rocks/line/" : "https://nivo.rocks/bar/";
  const previewLabel = useMemo(() => tab === "line" ? "Line preview" : "Bar preview", [tab]);

  return (
    <div className={styles.studio}>
      <div className={styles.notice}>
        <strong>Albert chart defaults</strong>
        <p>
          These settings become the published Nivo bar and line design for every chat chart.
          Data, tooltips, axis titles and accessibility stay governed by Albert.
          See the{" "}
          <a href={docsUrl} target="_blank" rel="noreferrer">official Nivo {tab === "line" ? "line" : "bar"} API</a>
          {" "}and the{" "}
          <a href="https://nivo.rocks/guides/theming/" target="_blank" rel="noreferrer">theming guide</a>.
        </p>
      </div>

      <div className={styles.toolbar}>
        <div>
          <strong>{dirty ? "Unsaved changes" : "Published design"}</strong>
          <span>{design.colors.mode === "scheme" ? `Scheme ${design.colors.scheme}` : `${design.colors.palette.length} custom colours`}</span>
        </div>
        <div className={styles.toolbarActions}>
          <button type="button" onClick={() => void reloadPublishedNivoChartDesign().then(() => void load())}>Reload</button>
          <button type="button" onClick={reset}>Reset shipped defaults</button>
          <button type="button" className={styles.primary} onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save as Albert default"}
          </button>
        </div>
      </div>

      {error ? <div className={styles.status} data-tone="error" role="alert">{error}</div> : null}
      {status ? <div className={styles.status} role="status">{status}</div> : null}

      <div className={styles.layout}>
        <section className={styles.previewPane} aria-label={previewLabel}>
          <header className={styles.previewHeader}>
            <div>
              <h3>{previewLabel}</h3>
              <p>Sample retail figures. Chat charts keep their own data.</p>
            </div>
          </header>
          <ChartPreview design={design} tab={tab} />
        </section>

        <section className={styles.editorPane} aria-label="Chart design controls">
          <header className={styles.editorHeader}>
            <h3>Parameters</h3>
            <nav className={styles.tabs} ref={tabRowRef} aria-label="Design surfaces">
              {STUDIO_TABS.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  ref={(node) => {
                    tabRefs.current[item.key] = node;
                  }}
                  aria-current={tab === item.key ? "page" : undefined}
                  onClick={() => setTab(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <span className={styles.tabIndicator} style={{ left: tabIndicator.left, width: tabIndicator.width }} aria-hidden="true" />
            </nav>
          </header>

          <div className={styles.editorBody}>
            {tab === "bar" || tab === "line" || tab === "theme" ? (
              <Section title="Colours">
                <div className={styles.grid}>
                  <SelectField
                    label="Colour mode"
                    value={design.colors.mode}
                    options={COLOR_MODES}
                    onChange={(mode) => update("colors.mode", mode)}
                  />
                  <SelectField
                    label="Nivo scheme"
                    value={design.colors.scheme}
                    options={NIVO_COLOR_SCHEMES}
                    onChange={(scheme) => update("colors.scheme", scheme)}
                  />
                </div>
                <div className={styles.palette}>
                  {design.colors.palette.map((colour, index) => (
                    <div className={styles.swatch} key={`${colour}-${index}`}>
                      <input
                        type="color"
                        value={hexForPicker(colour) ?? "#60753a"}
                        aria-label={`Palette colour ${index + 1}`}
                        onChange={(event) => {
                          const next = [...design.colors.palette];
                          next[index] = event.currentTarget.value;
                          update("colors.palette", next);
                        }}
                      />
                      <input
                        type="text"
                        value={colour}
                        onChange={(event) => {
                          const next = [...design.colors.palette];
                          next[index] = event.currentTarget.value;
                          update("colors.palette", next);
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`Remove colour ${index + 1}`}
                        onClick={() => update("colors.palette", design.colors.palette.filter((_, itemIndex) => itemIndex !== index))}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => update("colors.palette", [...design.colors.palette, "#60753a"])}
                  >
                    Add colour
                  </button>
                </div>
                <p className={styles.hint}>
                  Palette mode uses these exact colours. Scheme mode uses the selected Nivo categorical, diverging or sequential scale.
                  CSS variables such as var(--dash-chart-1) follow the Albert theme.
                </p>
              </Section>
            ) : null}

            {tab === "bar" ? (
              <>
                <Section title="Base and dimensions">
                  <div className={styles.grid}>
                    <SelectField label="Layout mode" value={design.bar.layoutMode} options={LAYOUT_MODES} onChange={(value) => update("bar.layoutMode", value)} />
                    <NumberField label="Height" value={design.bar.height} min={180} max={900} onChange={(value) => update("bar.height", value)} />
                    <SelectField label="Layout" value={design.bar.layout} options={BAR_LAYOUTS} onChange={(value) => update("bar.layout", value)} />
                    <SelectField label="Group mode" value={design.bar.groupMode} options={BAR_GROUP_MODES} onChange={(value) => update("bar.groupMode", value)} />
                    <SelectField label="Colour by" value={design.bar.colorBy} options={BAR_COLOR_BY} onChange={(value) => update("bar.colorBy", value)} />
                    <ToggleField label="Reverse" checked={design.bar.reverse} onChange={(value) => update("bar.reverse", value)} />
                    <NumberField label="Margin top" value={design.bar.margin.top} min={0} max={500} onChange={(value) => update("bar.margin.top", value)} />
                    <NumberField label="Margin right" value={design.bar.margin.right} min={0} max={500} onChange={(value) => update("bar.margin.right", value)} />
                    <NumberField label="Margin bottom" value={design.bar.margin.bottom} min={0} max={500} onChange={(value) => update("bar.margin.bottom", value)} />
                    <NumberField label="Margin left" value={design.bar.margin.left} min={0} max={500} onChange={(value) => update("bar.margin.left", value)} />
                  </div>
                  <p className={styles.hint}>Auto layout keeps Albert’s data-derived margins and height. Manual layout publishes these exact dimensions.</p>
                </Section>
                <Section title="Style">
                  <div className={styles.grid}>
                    <NumberField label="Padding (bar width)" value={design.bar.padding} min={0} max={0.95} step={0.01} onChange={(value) => update("bar.padding", value)} />
                    <NumberField label="Inner padding" value={design.bar.innerPadding} min={0} max={40} onChange={(value) => update("bar.innerPadding", value)} />
                    <NumberField label="Corner radius" value={design.bar.borderRadius} min={0} max={40} onChange={(value) => update("bar.borderRadius", value)} />
                    <NumberField label="Border width" value={design.bar.borderWidth} min={0} max={12} onChange={(value) => update("bar.borderWidth", value)} />
                    <SelectField label="Value scale" value={design.bar.valueScale.type} options={VALUE_SCALE_TYPES} onChange={(value) => update("bar.valueScale.type", value)} />
                    <ToggleField label="Round index scale" checked={design.bar.indexScale.round} onChange={(value) => update("bar.indexScale.round", value)} />
                    <ToggleField label="Stack value scale" checked={design.bar.valueScale.stacked} onChange={(value) => update("bar.valueScale.stacked", value)} />
                    <ToggleField label="Reverse value scale" checked={design.bar.valueScale.reverse} onChange={(value) => update("bar.valueScale.reverse", value)} />
                    <ToggleField label="Nice value scale" checked={design.bar.valueScale.nice} onChange={(value) => update("bar.valueScale.nice", value)} />
                    <ToggleField label="Clamp value scale" checked={design.bar.valueScale.clamp} onChange={(value) => update("bar.valueScale.clamp", value)} />
                  </div>
                  <InheritedColorFields label="Border colour" value={design.bar.borderColor} onChange={(value) => update("bar.borderColor", value)} />
                </Section>
                <Section title="Labels">
                  <div className={styles.grid}>
                    <ToggleField label="Show value labels" checked={design.bar.enableLabel} onChange={(value) => update("bar.enableLabel", value)} />
                    <SelectField label="Label position" value={design.bar.labelPosition} options={BAR_LABEL_POSITIONS} onChange={(value) => update("bar.labelPosition", value)} />
                    <NumberField label="Label offset" value={design.bar.labelOffset} min={-80} max={80} onChange={(value) => update("bar.labelOffset", value)} />
                    <NumberField label="Label skip width" value={design.bar.labelSkipWidth} min={0} max={200} onChange={(value) => update("bar.labelSkipWidth", value)} />
                    <NumberField label="Label skip height" value={design.bar.labelSkipHeight} min={0} max={200} onChange={(value) => update("bar.labelSkipHeight", value)} />
                    <TextField label="Value format" value={design.bar.valueFormat} onChange={(value) => update("bar.valueFormat", value)} />
                    <ToggleField label="Show totals" checked={design.bar.enableTotals} onChange={(value) => update("bar.enableTotals", value)} />
                    <NumberField label="Totals offset" value={design.bar.totalsOffset} min={-80} max={80} onChange={(value) => update("bar.totalsOffset", value)} />
                  </div>
                  <InheritedColorFields label="Label text colour" value={design.bar.labelTextColor} onChange={(value) => update("bar.labelTextColor", value)} />
                </Section>
                <Section title="Grid and interactivity">
                  <div className={styles.grid}>
                    <ToggleField label="Vertical grid" checked={design.bar.enableGridX} onChange={(value) => update("bar.enableGridX", value)} />
                    <ToggleField label="Horizontal grid" checked={design.bar.enableGridY} onChange={(value) => update("bar.enableGridY", value)} />
                    <TextField label="Grid X values" value={design.bar.gridXValues} onChange={(value) => update("bar.gridXValues", value)} />
                    <TextField label="Grid Y values" value={design.bar.gridYValues} onChange={(value) => update("bar.gridYValues", value)} />
                    <ToggleField label="Interactive" checked={design.bar.isInteractive} onChange={(value) => update("bar.isInteractive", value)} />
                    <ToggleField label="Animate" checked={design.bar.animate} onChange={(value) => update("bar.animate", value)} />
                    <ToggleField label="Animate on mount" checked={design.bar.animateOnMount} onChange={(value) => update("bar.animateOnMount", value)} />
                    <ToggleField label="Focusable" checked={design.bar.isFocusable} onChange={(value) => update("bar.isFocusable", value)} />
                    <TextField label="Role" value={design.bar.role} onChange={(value) => update("bar.role", value)} />
                  </div>
                </Section>
                <AxisFields title="Top axis" axis={design.bar.axisTop} onChange={(value) => update("bar.axisTop", value)} />
                <AxisFields title="Right axis" axis={design.bar.axisRight} onChange={(value) => update("bar.axisRight", value)} />
                <AxisFields title="Bottom axis" axis={design.bar.axisBottom} onChange={(value) => update("bar.axisBottom", value)} />
                <AxisFields title="Left axis" axis={design.bar.axisLeft} onChange={(value) => update("bar.axisLeft", value)} />
                <LegendFields legend={design.bar.legend} includeDataFrom onChange={(value) => update("bar.legend", value)} />
                <MotionFields motion={design.bar.motion} onChange={(value) => update("bar.motion", value)} />
                <LayerFields layers={design.bar.layers} options={BAR_LAYERS} onChange={(value) => update("bar.layers", value)} />
                <Section title="Advanced JSON (defs, fill, markers, annotations)">
                  <div className={styles.grid}>
                    <TextField label="defs JSON" value={design.bar.defsJson} onChange={(value) => update("bar.defsJson", value)} />
                    <TextField label="fill JSON" value={design.bar.fillJson} onChange={(value) => update("bar.fillJson", value)} />
                    <TextField label="markers JSON" value={design.bar.markersJson} onChange={(value) => update("bar.markersJson", value)} />
                    <TextField label="annotations JSON" value={design.bar.annotationsJson} onChange={(value) => update("bar.annotationsJson", value)} />
                  </div>
                </Section>
              </>
            ) : null}

            {tab === "line" ? (
              <>
                <Section title="Base and dimensions">
                  <div className={styles.grid}>
                    <SelectField label="Layout mode" value={design.line.layoutMode} options={LAYOUT_MODES} onChange={(value) => update("line.layoutMode", value)} />
                    <NumberField label="Height" value={design.line.height} min={180} max={900} onChange={(value) => update("line.height", value)} />
                    <NumberField label="Maximum X ticks" value={design.line.maxXTicks} min={2} max={40} onChange={(value) => update("line.maxXTicks", value)} />
                    <SelectField label="Curve" value={design.line.curve} options={LINE_CURVES} onChange={(value) => update("line.curve", value)} />
                    <NumberField label="Line width" value={design.line.lineWidth} min={0} max={16} onChange={(value) => update("line.lineWidth", value)} />
                    <SelectField label="X scale" value={design.line.xScale.type} options={LINE_X_SCALE_TYPES} onChange={(value) => update("line.xScale.type", value)} />
                    <SelectField label="Y scale" value={design.line.yScale.type} options={LINE_Y_SCALE_TYPES} onChange={(value) => update("line.yScale.type", value)} />
                    <ToggleField label="Stack Y" checked={design.line.yScale.stacked} onChange={(value) => update("line.yScale.stacked", value)} />
                    <ToggleField label="Reverse Y" checked={design.line.yScale.reverse} onChange={(value) => update("line.yScale.reverse", value)} />
                    <ToggleField label="Nice Y" checked={design.line.yScale.nice} onChange={(value) => update("line.yScale.nice", value)} />
                    <ToggleField label="Clamp Y" checked={design.line.yScale.clamp} onChange={(value) => update("line.yScale.clamp", value)} />
                    <NumberField label="Margin top" value={design.line.margin.top} min={0} max={500} onChange={(value) => update("line.margin.top", value)} />
                    <NumberField label="Margin right" value={design.line.margin.right} min={0} max={500} onChange={(value) => update("line.margin.right", value)} />
                    <NumberField label="Margin bottom" value={design.line.margin.bottom} min={0} max={500} onChange={(value) => update("line.margin.bottom", value)} />
                    <NumberField label="Margin left" value={design.line.margin.left} min={0} max={500} onChange={(value) => update("line.margin.left", value)} />
                    <TextField label="X format" value={design.line.xFormat} onChange={(value) => update("line.xFormat", value)} />
                    <TextField label="Y format" value={design.line.yFormat} onChange={(value) => update("line.yFormat", value)} />
                  </div>
                </Section>
                <Section title="Area and points">
                  <div className={styles.grid}>
                    <ToggleField label="Fill area" checked={design.line.enableArea} onChange={(value) => update("line.enableArea", value)} />
                    <NumberField label="Area opacity" value={design.line.areaOpacity} min={0} max={1} step={0.05} onChange={(value) => update("line.areaOpacity", value)} />
                    <NumberField label="Area baseline" value={design.line.areaBaselineValue} min={-1_000_000} max={1_000_000} onChange={(value) => update("line.areaBaselineValue", value)} />
                    <SelectField label="Area blend mode" value={design.line.areaBlendMode} options={BLEND_MODES} onChange={(value) => update("line.areaBlendMode", value)} />
                    <ToggleField label="Show points" checked={design.line.enablePoints} onChange={(value) => update("line.enablePoints", value)} />
                    <NumberField label="Point size" value={design.line.pointSize} min={0} max={40} onChange={(value) => update("line.pointSize", value)} />
                    <NumberField label="Point border" value={design.line.pointBorderWidth} min={0} max={12} onChange={(value) => update("line.pointBorderWidth", value)} />
                    <ToggleField label="Point labels" checked={design.line.enablePointLabel} onChange={(value) => update("line.enablePointLabel", value)} />
                    <NumberField label="Point label Y offset" value={design.line.pointLabelYOffset} min={-80} max={80} onChange={(value) => update("line.pointLabelYOffset", value)} />
                  </div>
                  <InheritedColorFields label="Point colour" value={design.line.pointColor} onChange={(value) => update("line.pointColor", value)} />
                  <InheritedColorFields label="Point border colour" value={design.line.pointBorderColor} onChange={(value) => update("line.pointBorderColor", value)} />
                </Section>
                <Section title="Grid and interactivity">
                  <div className={styles.grid}>
                    <ToggleField label="Vertical grid" checked={design.line.enableGridX} onChange={(value) => update("line.enableGridX", value)} />
                    <ToggleField label="Horizontal grid" checked={design.line.enableGridY} onChange={(value) => update("line.enableGridY", value)} />
                    <TextField label="Grid X values" value={design.line.gridXValues} onChange={(value) => update("line.gridXValues", value)} />
                    <TextField label="Grid Y values" value={design.line.gridYValues} onChange={(value) => update("line.gridYValues", value)} />
                    <ToggleField label="Use mesh" checked={design.line.useMesh} onChange={(value) => update("line.useMesh", value)} />
                    <ToggleField label="Debug mesh" checked={design.line.debugMesh} onChange={(value) => update("line.debugMesh", value)} />
                    <SelectField label="Slices" value={design.line.enableSlices} options={SLICE_MODES} onChange={(value) => update("line.enableSlices", value)} />
                    <ToggleField label="Debug slices" checked={design.line.debugSlices} onChange={(value) => update("line.debugSlices", value)} />
                    <ToggleField label="Crosshair" checked={design.line.enableCrosshair} onChange={(value) => update("line.enableCrosshair", value)} />
                    <SelectField label="Crosshair type" value={design.line.crosshairType} options={CROSSHAIR_TYPES} onChange={(value) => update("line.crosshairType", value)} />
                    <ToggleField label="Touch crosshair" checked={design.line.enableTouchCrosshair} onChange={(value) => update("line.enableTouchCrosshair", value)} />
                    <ToggleField label="Interactive" checked={design.line.isInteractive} onChange={(value) => update("line.isInteractive", value)} />
                    <ToggleField label="Animate" checked={design.line.animate} onChange={(value) => update("line.animate", value)} />
                    <ToggleField label="Focusable" checked={design.line.isFocusable} onChange={(value) => update("line.isFocusable", value)} />
                    <TextField label="Role" value={design.line.role} onChange={(value) => update("line.role", value)} />
                  </div>
                </Section>
                <AxisFields title="Top axis" axis={design.line.axisTop} onChange={(value) => update("line.axisTop", value)} />
                <AxisFields title="Right axis" axis={design.line.axisRight} onChange={(value) => update("line.axisRight", value)} />
                <AxisFields title="Bottom axis" axis={design.line.axisBottom} onChange={(value) => update("line.axisBottom", value)} />
                <AxisFields title="Left axis" axis={design.line.axisLeft} onChange={(value) => update("line.axisLeft", value)} />
                <LegendFields legend={design.line.legend} onChange={(value) => update("line.legend", value)} />
                <MotionFields motion={design.line.motion} onChange={(value) => update("line.motion", value)} />
                <LayerFields layers={design.line.layers} options={LINE_LAYERS} onChange={(value) => update("line.layers", value)} />
                <Section title="Advanced JSON (defs, fill, markers)">
                  <div className={styles.grid}>
                    <TextField label="defs JSON" value={design.line.defsJson} onChange={(value) => update("line.defsJson", value)} />
                    <TextField label="fill JSON" value={design.line.fillJson} onChange={(value) => update("line.fillJson", value)} />
                    <TextField label="markers JSON" value={design.line.markersJson} onChange={(value) => update("line.markersJson", value)} />
                  </div>
                </Section>
              </>
            ) : null}

            {tab === "theme" ? (
              <>
                <Section title="Canvas and text">
                  <div className={styles.grid}>
                    <ColorField label="Background" value={theme.background} onChange={(value) => update("theme.background", value)} />
                    <TextField label="Font family" value={theme.text.fontFamily} onChange={(value) => update("theme.text.fontFamily", value)} />
                    <NumberField label="Font size" value={theme.text.fontSize} min={6} max={32} onChange={(value) => update("theme.text.fontSize", value)} />
                    <ColorField label="Text fill" value={theme.text.fill} onChange={(value) => update("theme.text.fill", value)} />
                    <NumberField label="Text outline width" value={theme.text.outlineWidth} min={0} max={12} onChange={(value) => update("theme.text.outlineWidth", value)} />
                    <ColorField label="Text outline colour" value={theme.text.outlineColor} onChange={(value) => update("theme.text.outlineColor", value)} />
                    <NumberField label="Text outline opacity" value={theme.text.outlineOpacity} min={0} max={1} step={0.05} onChange={(value) => update("theme.text.outlineOpacity", value)} />
                  </div>
                </Section>
                <Section title="Axis">
                  <div className={styles.grid}>
                    <ColorField label="Domain stroke" value={theme.axis.domain.line.stroke} onChange={(value) => update("theme.axis.domain.line.stroke", value)} />
                    <NumberField label="Domain width" value={theme.axis.domain.line.strokeWidth} min={0} max={12} onChange={(value) => update("theme.axis.domain.line.strokeWidth", value)} />
                    <ColorField label="Tick stroke" value={theme.axis.ticks.line.stroke} onChange={(value) => update("theme.axis.ticks.line.stroke", value)} />
                    <NumberField label="Tick width" value={theme.axis.ticks.line.strokeWidth} min={0} max={12} onChange={(value) => update("theme.axis.ticks.line.strokeWidth", value)} />
                    <ColorField label="Tick text" value={theme.axis.ticks.text.fill} onChange={(value) => update("theme.axis.ticks.text.fill", value)} />
                    <NumberField label="Tick text size" value={theme.axis.ticks.text.fontSize} min={6} max={32} onChange={(value) => update("theme.axis.ticks.text.fontSize", value)} />
                    <ColorField label="Axis title" value={theme.axis.legend.text.fill} onChange={(value) => update("theme.axis.legend.text.fill", value)} />
                    <NumberField label="Axis title size" value={theme.axis.legend.text.fontSize} min={6} max={32} onChange={(value) => update("theme.axis.legend.text.fontSize", value)} />
                  </div>
                </Section>
                <Section title="Grid, crosshair and legends">
                  <div className={styles.grid}>
                    <ColorField label="Grid stroke" value={theme.grid.line.stroke} onChange={(value) => update("theme.grid.line.stroke", value)} />
                    <NumberField label="Grid width" value={theme.grid.line.strokeWidth} min={0} max={12} onChange={(value) => update("theme.grid.line.strokeWidth", value)} />
                    <TextField label="Grid dash array" value={theme.grid.line.strokeDasharray} onChange={(value) => update("theme.grid.line.strokeDasharray", value)} />
                    <ColorField label="Crosshair stroke" value={theme.crosshair.line.stroke} onChange={(value) => update("theme.crosshair.line.stroke", value)} />
                    <NumberField label="Crosshair width" value={theme.crosshair.line.strokeWidth} min={0} max={12} onChange={(value) => update("theme.crosshair.line.strokeWidth", value)} />
                    <ColorField label="Legend text" value={theme.legends.text.fill} onChange={(value) => update("theme.legends.text.fill", value)} />
                    <NumberField label="Legend text size" value={theme.legends.text.fontSize} min={6} max={32} onChange={(value) => update("theme.legends.text.fontSize", value)} />
                    <ColorField label="Hidden symbol" value={theme.legends.hidden.symbolFill} onChange={(value) => update("theme.legends.hidden.symbolFill", value)} />
                    <NumberField label="Hidden symbol opacity" value={theme.legends.hidden.symbolOpacity} min={0} max={1} step={0.05} onChange={(value) => update("theme.legends.hidden.symbolOpacity", value)} />
                  </div>
                </Section>
                <Section title="Labels, markers, dots and tooltip">
                  <div className={styles.grid}>
                    <ColorField label="Label fill" value={theme.labels.text.fill} onChange={(value) => update("theme.labels.text.fill", value)} />
                    <NumberField label="Label size" value={theme.labels.text.fontSize} min={6} max={32} onChange={(value) => update("theme.labels.text.fontSize", value)} />
                    <ColorField label="Marker line" value={theme.markers.lineColor} onChange={(value) => update("theme.markers.lineColor", value)} />
                    <NumberField label="Marker width" value={theme.markers.lineStrokeWidth} min={0} max={12} onChange={(value) => update("theme.markers.lineStrokeWidth", value)} />
                    <ColorField label="Dot text" value={theme.dots.text.fill} onChange={(value) => update("theme.dots.text.fill", value)} />
                    <ColorField label="Tooltip background" value={theme.tooltip.containerBackground} onChange={(value) => update("theme.tooltip.containerBackground", value)} />
                    <ColorField label="Tooltip text" value={theme.tooltip.containerColor} onChange={(value) => update("theme.tooltip.containerColor", value)} />
                    <NumberField label="Tooltip size" value={theme.tooltip.containerFontSize} min={8} max={24} onChange={(value) => update("theme.tooltip.containerFontSize", value)} />
                    <NumberField label="Tooltip radius" value={theme.tooltip.containerBorderRadius} min={0} max={32} onChange={(value) => update("theme.tooltip.containerBorderRadius", value)} />
                    <NumberField label="Tooltip padding" value={theme.tooltip.containerPadding} min={0} max={32} onChange={(value) => update("theme.tooltip.containerPadding", value)} />
                    <TextField label="Tooltip shadow" value={theme.tooltip.containerBoxShadow} onChange={(value) => update("theme.tooltip.containerBoxShadow", value)} />
                  </div>
                </Section>
                <Section title="Annotations">
                  <div className={styles.grid}>
                    <ColorField label="Annotation text" value={theme.annotations.text.fill} onChange={(value) => update("theme.annotations.text.fill", value)} />
                    <ColorField label="Link stroke" value={theme.annotations.linkStroke} onChange={(value) => update("theme.annotations.linkStroke", value)} />
                    <NumberField label="Link width" value={theme.annotations.linkStrokeWidth} min={0} max={12} onChange={(value) => update("theme.annotations.linkStrokeWidth", value)} />
                    <ColorField label="Outline stroke" value={theme.annotations.outlineStroke} onChange={(value) => update("theme.annotations.outlineStroke", value)} />
                    <NumberField label="Outline width" value={theme.annotations.outlineWidth} min={0} max={12} onChange={(value) => update("theme.annotations.outlineWidth", value)} />
                    <ColorField label="Outline colour" value={theme.annotations.outlineColor} onChange={(value) => update("theme.annotations.outlineColor", value)} />
                    <NumberField label="Outline opacity" value={theme.annotations.outlineOpacity} min={0} max={1} step={0.05} onChange={(value) => update("theme.annotations.outlineOpacity", value)} />
                    <ColorField label="Symbol fill" value={theme.annotations.symbolFill} onChange={(value) => update("theme.annotations.symbolFill", value)} />
                  </div>
                </Section>
              </>
            ) : null}

            {tab === "json" ? (
              <Section title="Full Nivo design JSON">
                <textarea
                  className={styles.json}
                  value={jsonText}
                  onChange={(event) => setJsonText(event.currentTarget.value)}
                  aria-label="Nivo chart design JSON"
                />
                <p className={styles.hint}>
                  This is the complete published document, including every bar, line and theme parameter from the Nivo 0.99 API that can be serialised.
                  Functions such as custom tooltips, bar components and custom layers stay in Albert.
                </p>
                <div className={styles.toolbarActions}>
                  <button type="button" onClick={applyJson}>Apply JSON to preview</button>
                </div>
              </Section>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
