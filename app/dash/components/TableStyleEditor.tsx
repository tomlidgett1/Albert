"use client";

import type { DashboardTableStyle } from "@/packages/shared/src/dashboard-pivot";
import styles from "./element-editor.module.css";

/** The same presentation controls apply to regular tables and pivots. */
export function TableStyleEditor({
  value,
  onChange,
  defaultVerticalGrid = false,
}: Readonly<{
  value?: DashboardTableStyle;
  onChange: (value: DashboardTableStyle) => void;
  defaultVerticalGrid?: boolean;
}>) {
  return (
    <details open className={styles.tableStyleSection}>
      <summary>Table style</summary>
      <div className={styles.settings}>
        <label className={styles.setting}>
          <span>Preset</span>
          <select aria-label="Table style" value={value?.preset ?? "spreadsheet"} onChange={event => onChange({
            ...value,
            preset: event.target.value as "spreadsheet" | "presentation",
            rowHeight: event.target.value === "presentation" ? "large" : "small",
            verticalGrid: event.target.value === "spreadsheet",
            bandedRows: false,
          })}>
            <option value="spreadsheet">Spreadsheet</option>
            <option value="presentation">Presentation</option>
          </select>
        </label>
        <label className={styles.setting}>
          <span>Cell spacing</span>
          <select aria-label="Cell spacing" value={value?.rowHeight ?? "small"} onChange={event => onChange({
            ...value, rowHeight: event.target.value as "small" | "medium" | "large",
          })}>
            <option value="small">Small</option>
            <option value="medium">Medium</option>
            <option value="large">Large</option>
          </select>
        </label>
        <label className={styles.setting}>
          <span>Banded rows</span>
          <input type="checkbox" role="switch" aria-label="Banded rows" checked={value?.bandedRows ?? false}
            onChange={event => onChange({ ...value, bandedRows: event.target.checked })} />
        </label>
        <label className={styles.setting}>
          <span>Vertical gridlines</span>
          <input type="checkbox" role="switch" aria-label="Vertical gridlines" checked={value?.verticalGrid ?? defaultVerticalGrid}
            onChange={event => onChange({ ...value, verticalGrid: event.target.checked })} />
        </label>
      </div>
    </details>
  );
}
