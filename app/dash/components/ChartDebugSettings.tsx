"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "../dash.module.css";
import {
  LEGEND_ANCHORS,
  LINE_CURVES,
  normalizeChartDebugConfig,
  serializeNivoChartDebugConfig,
  type ChartAxisDebugConfig,
  type ChartLegendDebugConfig,
  type ChartMarginConfig,
  type NivoChartDebugConfig,
} from "./chart-debug-config";

const rawDebugStorageKey = "albert:chat:raw-debugger";
const chartDebugEventName = "albert:nivo-chart-debug-change";

function storageKey(chartType: NivoChartDebugConfig["chartType"]) {
  return `albert:nivo-debug:${chartType}:v3`;
}

export function useNivoChartDebugConfig(defaults: NivoChartDebugConfig) {
  const subscribeToAvailability = useCallback(() => () => {}, []);
  const enabled = useSyncExternalStore(
    subscribeToAvailability,
    () => {
      if (process.env.NODE_ENV !== "production") return true;
      try {
        return window.localStorage.getItem(rawDebugStorageKey) === "true"
          || new URLSearchParams(window.location.search).get("debug") === "1";
      } catch {
        return false;
      }
    },
    () => process.env.NODE_ENV !== "production",
  );
  const subscribeToConfig = useCallback((notify: () => void) => {
    const acceptChange = (event: Event) => {
      const detail = (event as CustomEvent<{ chartType: string }>).detail;
      if (detail?.chartType === defaults.chartType) notify();
    };
    const acceptStorage = (event: StorageEvent) => {
      if (event.key === storageKey(defaults.chartType)) notify();
    };
    window.addEventListener(chartDebugEventName, acceptChange);
    window.addEventListener("storage", acceptStorage);
    return () => {
      window.removeEventListener(chartDebugEventName, acceptChange);
      window.removeEventListener("storage", acceptStorage);
    };
  }, [defaults.chartType]);
  const getConfigSnapshot = useCallback(() => {
    if (!enabled) return null;
    try {
      return window.localStorage.getItem(storageKey(defaults.chartType));
    } catch {
      return null;
    }
  }, [defaults.chartType, enabled]);
  const storedConfig = useSyncExternalStore(subscribeToConfig, getConfigSnapshot, () => null);
  const override = useMemo(() => {
    if (!storedConfig) return null;
    try {
      return normalizeChartDebugConfig(JSON.parse(storedConfig), defaults);
    } catch {
      return null;
    }
  }, [defaults, storedConfig]);

  const update = useCallback((next: NivoChartDebugConfig) => {
    if (next.chartType !== defaults.chartType) return;
    const normalized = normalizeChartDebugConfig(next, defaults);
    try {
      window.localStorage.setItem(storageKey(defaults.chartType), JSON.stringify(normalized));
    } catch {
      // Live tuning still works when browser storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(chartDebugEventName, {
      detail: { chartType: defaults.chartType },
    }));
  }, [defaults]);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey(defaults.chartType));
    } catch {
      // State is still reset for this render when storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent(chartDebugEventName, {
      detail: { chartType: defaults.chartType },
    }));
  }, [defaults.chartType]);

  return {
    enabled,
    hasOverride: Boolean(override && override.chartType === defaults.chartType),
    config: enabled && override?.chartType === defaults.chartType ? override : defaults,
    update,
    reset,
  } as const;
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
    <label className={styles.chartDebugField}>
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
    <label className={styles.chartDebugField}>
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
    <label className={styles.chartDebugToggle}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function DebugSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className={styles.chartDebugSection}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

function MarginFields({
  margin,
  onChange,
}: {
  margin: ChartMarginConfig;
  onChange: (margin: ChartMarginConfig) => void;
}) {
  return (
    <div className={styles.chartDebugGrid}>
      {(["top", "right", "bottom", "left"] as const).map((edge) => (
        <NumberField
          key={edge}
          label={`Margin ${edge}`}
          value={margin[edge]}
          min={0}
          max={500}
          onChange={(value) => onChange({ ...margin, [edge]: value })}
        />
      ))}
    </div>
  );
}

function AxisFields({
  axis,
  onChange,
}: {
  axis: ChartAxisDebugConfig;
  onChange: (axis: ChartAxisDebugConfig) => void;
}) {
  return (
    <>
      <ToggleField
        label="Show axis title"
        checked={axis.showLegend}
        onChange={(showLegend) => onChange({ ...axis, showLegend })}
      />
      <div className={styles.chartDebugGrid}>
        <NumberField label="Tick size" value={axis.tickSize} min={0} max={40} onChange={(tickSize) => onChange({ ...axis, tickSize })} />
        <NumberField label="Tick padding" value={axis.tickPadding} min={0} max={80} onChange={(tickPadding) => onChange({ ...axis, tickPadding })} />
        <NumberField label="Tick rotation" value={axis.tickRotation} min={-90} max={90} onChange={(tickRotation) => onChange({ ...axis, tickRotation })} />
        <NumberField label="Truncate at (0 = off)" value={axis.truncateTickAt} min={0} max={100} onChange={(truncateTickAt) => onChange({ ...axis, truncateTickAt })} />
        <NumberField label="Title offset" value={axis.legendOffset} min={-500} max={500} onChange={(legendOffset) => onChange({ ...axis, legendOffset })} />
      </div>
    </>
  );
}

function LegendFields({
  legend,
  onChange,
}: {
  legend: ChartLegendDebugConfig;
  onChange: (legend: ChartLegendDebugConfig) => void;
}) {
  return (
    <>
      <ToggleField
        label="Show legend"
        checked={legend.enabled}
        onChange={(enabled) => onChange({ ...legend, enabled })}
      />
      <div className={styles.chartDebugGrid}>
        <SelectField
          label="Anchor"
          value={legend.anchor}
          options={LEGEND_ANCHORS}
          onChange={(anchor) => onChange({ ...legend, anchor: anchor as ChartLegendDebugConfig["anchor"] })}
        />
        <SelectField
          label="Direction"
          value={legend.direction}
          options={["column", "row"]}
          onChange={(direction) => onChange({ ...legend, direction: direction as ChartLegendDebugConfig["direction"] })}
        />
        <NumberField label="Translate X" value={legend.translateX} min={-500} max={500} onChange={(translateX) => onChange({ ...legend, translateX })} />
        <NumberField label="Translate Y" value={legend.translateY} min={-500} max={500} onChange={(translateY) => onChange({ ...legend, translateY })} />
        <NumberField label="Item width" value={legend.itemWidth} min={20} max={500} onChange={(itemWidth) => onChange({ ...legend, itemWidth })} />
        <NumberField label="Item height" value={legend.itemHeight} min={10} max={100} onChange={(itemHeight) => onChange({ ...legend, itemHeight })} />
        <NumberField label="Item spacing" value={legend.itemsSpacing} min={0} max={80} onChange={(itemsSpacing) => onChange({ ...legend, itemsSpacing })} />
        <NumberField label="Symbol size" value={legend.symbolSize} min={2} max={48} onChange={(symbolSize) => onChange({ ...legend, symbolSize })} />
      </div>
    </>
  );
}

export default function ChartDebugSettings({
  config,
  onChange,
  onReset,
}: {
  config: NivoChartDebugConfig;
  onChange: (config: NivoChartDebugConfig) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId().replaceAll(":", "");
  const json = useMemo(() => serializeNivoChartDebugConfig(config), [config]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch {
      // The JSON remains selectable if clipboard permission is unavailable.
    }
  };

  const updateMargin = (margin: ChartMarginConfig) => onChange({ ...config, margin });
  const updateAxisBottom = (axisBottom: ChartAxisDebugConfig) => onChange({ ...config, axisBottom });
  const updateAxisLeft = (axisLeft: ChartAxisDebugConfig) => onChange({ ...config, axisLeft });
  const updateLegend = (legend: ChartLegendDebugConfig) => onChange({ ...config, legend });
  const docsUrl = config.chartType === "line" ? "https://nivo.rocks/line/" : "https://nivo.rocks/bar/";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={styles.chartDebugTrigger}
        aria-expanded={open}
        aria-controls={open ? titleId : undefined}
        onClick={(event) => {
          if (!open) {
            setPortalRoot(event.currentTarget.closest<HTMLElement>(`.${styles.dash}`) ?? document.body);
          }
          setOpen((current) => !current);
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        Tune
      </button>
      {open && portalRoot ? createPortal(
        <div
          ref={panelRef}
          className={styles.chartDebugPanel}
          role="dialog"
          aria-labelledby={titleId}
        >
          <header className={styles.chartDebugHeader}>
            <div>
              <span>Live Nivo configuration</span>
              <h2 id={titleId}>{config.chartType === "line" ? "Line chart" : "Bar chart"}</h2>
              <p>Local override only. Publish Albert defaults from Admin, Charts.</p>
            </div>
            <button
              type="button"
              className={styles.chartDebugClose}
              aria-label="Close chart settings"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              ×
            </button>
          </header>

          <div className={styles.chartDebugBody}>
            <DebugSection title="Canvas and margins">
              <NumberField label="Chart height" value={config.height} min={220} max={900} onChange={(height) => onChange({ ...config, height })} />
              <MarginFields margin={config.margin} onChange={updateMargin} />
            </DebugSection>

            {config.chartType === "line" ? (
              <>
                <DebugSection title="Line and scale">
                  <div className={styles.chartDebugGrid}>
                    <SelectField label="Curve" value={config.curve} options={LINE_CURVES} onChange={(curve) => onChange({ ...config, curve: curve as typeof config.curve })} />
                    <NumberField label="Line width" value={config.lineWidth} min={1} max={12} onChange={(lineWidth) => onChange({ ...config, lineWidth })} />
                    <NumberField label="Maximum X ticks" value={config.maxXTicks} min={2} max={40} onChange={(maxXTicks) => onChange({ ...config, maxXTicks })} />
                    <NumberField label="Area opacity" value={config.areaOpacity} min={0} max={1} step={0.05} onChange={(areaOpacity) => onChange({ ...config, areaOpacity })} />
                    <NumberField label="Point size" value={config.pointSize} min={0} max={40} onChange={(pointSize) => onChange({ ...config, pointSize })} />
                    <NumberField label="Point border" value={config.pointBorderWidth} min={0} max={12} onChange={(pointBorderWidth) => onChange({ ...config, pointBorderWidth })} />
                  </div>
                  <div className={styles.chartDebugToggleGrid}>
                    <ToggleField label="Stack Y values" checked={config.yScale.stacked} onChange={(stacked) => onChange({ ...config, yScale: { ...config.yScale, stacked } })} />
                    <ToggleField label="Reverse Y scale" checked={config.yScale.reverse} onChange={(reverse) => onChange({ ...config, yScale: { ...config.yScale, reverse } })} />
                    <ToggleField label="Start Y at zero" checked={config.yScale.min === 0} onChange={(zero) => onChange({ ...config, yScale: { ...config.yScale, min: zero ? 0 : "auto" } })} />
                    <ToggleField label="Fill area" checked={config.enableArea} onChange={(enableArea) => onChange({ ...config, enableArea })} />
                    <ToggleField label="Show points" checked={config.enablePoints} onChange={(enablePoints) => onChange({ ...config, enablePoints })} />
                    <ToggleField label="Touch crosshair" checked={config.enableTouchCrosshair} onChange={(enableTouchCrosshair) => onChange({ ...config, enableTouchCrosshair })} />
                    <ToggleField label="Use mesh" checked={config.useMesh} onChange={(useMesh) => onChange({ ...config, useMesh })} />
                  </div>
                </DebugSection>
              </>
            ) : (
              <DebugSection title="Bars and labels">
                <div className={styles.chartDebugGrid}>
                  <SelectField label="Layout" value={config.layout} options={["vertical", "horizontal"]} onChange={(layout) => onChange({ ...config, layout: layout as typeof config.layout })} />
                  <SelectField label="Group mode" value={config.groupMode} options={["grouped", "stacked"]} onChange={(groupMode) => onChange({ ...config, groupMode: groupMode as typeof config.groupMode })} />
                  <NumberField label="Padding" value={config.padding} min={0} max={0.95} step={0.05} onChange={(padding) => onChange({ ...config, padding })} />
                  <NumberField label="Inner padding" value={config.innerPadding} min={0} max={40} onChange={(innerPadding) => onChange({ ...config, innerPadding })} />
                  <NumberField label="Corner radius" value={config.borderRadius} min={0} max={30} onChange={(borderRadius) => onChange({ ...config, borderRadius })} />
                  <NumberField label="Border width" value={config.borderWidth} min={0} max={10} onChange={(borderWidth) => onChange({ ...config, borderWidth })} />
                  <NumberField label="Label skip width" value={config.labelSkipWidth} min={0} max={200} onChange={(labelSkipWidth) => onChange({ ...config, labelSkipWidth })} />
                  <NumberField label="Label skip height" value={config.labelSkipHeight} min={0} max={200} onChange={(labelSkipHeight) => onChange({ ...config, labelSkipHeight })} />
                </div>
                <ToggleField label="Show value labels" checked={config.enableLabel} onChange={(enableLabel) => onChange({ ...config, enableLabel })} />
              </DebugSection>
            )}

            <DebugSection title="Grid">
              <div className={styles.chartDebugToggleGrid}>
                <ToggleField label="Vertical grid" checked={config.enableGridX} onChange={(enableGridX) => onChange({ ...config, enableGridX })} />
                <ToggleField label="Horizontal grid" checked={config.enableGridY} onChange={(enableGridY) => onChange({ ...config, enableGridY })} />
              </div>
            </DebugSection>

            <DebugSection title="Bottom axis">
              <AxisFields axis={config.axisBottom} onChange={updateAxisBottom} />
            </DebugSection>

            <DebugSection title="Left axis">
              <AxisFields axis={config.axisLeft} onChange={updateAxisLeft} />
            </DebugSection>

            <DebugSection title="Legend">
              <LegendFields legend={config.legend} onChange={updateLegend} />
            </DebugSection>

            <DebugSection title="Config to paste into chat">
              <textarea className={styles.chartDebugJson} value={json} readOnly rows={14} aria-label="Nivo chart configuration JSON" />
              <p className={styles.chartDebugHint}>
                Data, formatting, tooltips and accessibility remain governed by Albert. Save product defaults in Admin, Charts. See the{" "}
                <a href={docsUrl} target="_blank" rel="noreferrer">official Nivo {config.chartType} docs</a>.
              </p>
            </DebugSection>
          </div>

          <footer className={styles.chartDebugFooter}>
            <button type="button" className={styles.chartDebugReset} onClick={onReset}>Reset defaults</button>
            <button type="button" className={styles.chartDebugCopy} onClick={copy}>{copied ? "Copied" : "Copy JSON"}</button>
          </footer>
        </div>,
        portalRoot,
      ) : null}
    </>
  );
}
