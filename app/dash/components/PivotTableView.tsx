"use client";

import { useMemo, useState, type CSSProperties } from "react";
import {
  buildPivotModel,
  PIVOT_VALUES,
  pivotValueLabel,
  pivotGroupId,
  type DashboardPivot,
  type DashboardTableStyle,
  type PivotAxisEntry,
  type PivotSource,
} from "@/packages/shared/src/dashboard-pivot";
import { formatDashboardCell } from "./dashboard-values";
import styles from "./dashboard-tile.module.css";

export function PivotTableView({
  source,
  config,
  tableStyle,
  title,
}: Readonly<{
  source: PivotSource;
  config: DashboardPivot;
  tableStyle?: DashboardTableStyle;
  title: string;
}>) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const model = useMemo(
    () => buildPivotModel(source, config, collapsed),
    [source, config, collapsed],
  );
  const separate = config.rowLayout === "separate";
  const rowColumnCount =
    config.showRowHeaders === false
      ? 0
      : separate
        ? Math.max(1, model.rowAxis.length)
        : 1;
  const headerAxis = model.columnAxis.filter(
    (key) => key !== PIVOT_VALUES || config.values.length > 1,
  );
  const headerDepth = Math.max(1, headerAxis.length);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const fieldLabel = (key: string) =>
    key === PIVOT_VALUES
      ? "Values"
      : (source.fields.find((field) => field.key === key)?.label ?? key);
  const pathLabel = (entry: PivotAxisEntry, index: number) => {
    if (index >= entry.path.length) return "";
    const value = entry.path[index];
    if (model.columnAxis[index] === PIVOT_VALUES) {
      const metric = config.values.find((metric) => metric.column === value);
      return metric ? pivotValueLabel(metric, source.fields) : "Values";
    }
    return value == null ? "(Null)" : String(value);
  };
  let ambiguous = false;
  const body = model.rows.map((row, rowIndex) => (
    <tr
      key={row.id}
      data-total={row.total ? "true" : undefined}
      data-group={row.parent ? "true" : undefined}
    >
      {Array.from({ length: rowColumnCount }, (_, index) => {
        const value = separate ? row.path[index] : row.label;
        const sameAsPrevious =
          rowIndex > 0 &&
          !row.total &&
          !model.rows[rowIndex - 1]?.total &&
          JSON.stringify(row.path.slice(0, index + 1)) ===
            JSON.stringify(model.rows[rowIndex - 1]?.path.slice(0, index + 1));
        const metric =
          separate && model.rowAxis[index] === PIVOT_VALUES
            ? config.values.find((metric) => metric.column === value)
            : null;
        const label = row.total
          ? index === 0
            ? row.label
            : ""
          : separate
            ? value === undefined ||
              (!config.repeatRowLabels && sameAsPrevious && !row.parent)
              ? ""
              : metric
                ? pivotValueLabel(metric, source.fields)
                : value == null
                  ? "(Null)"
                  : String(value)
            : row.label;
        return (
          <th
            key={index}
            scope="row"
            className={styles.pivotRowHeader}
            style={
              {
                "--pivot-indent": `${separate ? 0 : row.depth * 16}px`,
                "--pivot-left": `${index * 160}px`,
              } as CSSProperties
            }
          >
            <span className={styles.pivotRowLabel}>
              {row.parent && (!separate || index === row.depth) ? (
                <button
                  type="button"
                  className={styles.pivotDisclosure}
                  aria-label={`${collapsed.has(row.id) ? "Expand" : "Collapse"} ${row.label}`}
                  aria-expanded={!collapsed.has(row.id)}
                  onClick={() => toggle(row.id)}
                >
                  {collapsed.has(row.id) ? "+" : "−"}
                </button>
              ) : null}
              <span>{label}</span>
            </span>
          </th>
        );
      })}
      {model.columns.map((column) => {
        const cell = model.cell(row, column);
        ambiguous ||= cell.ambiguous;
        const id = `${row.id}|${column.id}`;
        const text = cell.ambiguous
          ? "—"
          : cell.value == null
            ? (config.emptyValue ?? "")
            : cell.field
              ? formatDashboardCell(
                  cell.value,
                  cell.field,
                  cell.valueConfig ?? undefined,
                )
              : "";
        return (
          <td
            key={column.id}
            data-numeric="true"
            data-total={column.total ? "true" : undefined}
            data-selected={selectedCell === id ? "true" : undefined}
            tabIndex={
              selectedCell === id ||
              (!selectedCell && rowIndex === 0 && column === model.columns[0])
                ? 0
                : -1
            }
            aria-label={`${row.label}, ${column.label}: ${cell.ambiguous ? "Choose an aggregation for multiple values" : text || "Empty"}`}
            onClick={() => setSelectedCell(id)}
            onKeyDown={(event) => {
              const delta = {
                ArrowLeft: -1,
                ArrowRight: 1,
                ArrowUp: -model.columns.length,
                ArrowDown: model.columns.length,
              }[event.key];
              if (delta === undefined) return;
              event.preventDefault();
              const index =
                rowIndex * model.columns.length + model.columns.indexOf(column);
              const next = Math.max(
                0,
                Math.min(
                  model.rows.length * model.columns.length - 1,
                  index + delta,
                ),
              );
              setSelectedCell(
                `${model.rows[Math.floor(next / model.columns.length)]!.id}|${model.columns[next % model.columns.length]!.id}`,
              );
              const cells = event.currentTarget
                .closest("tbody")
                ?.querySelectorAll<HTMLTableCellElement>("td");
              cells?.[next]?.focus();
            }}
          >
            {text}
          </td>
        );
      })}
    </tr>
  ));
  return (
    <div
      className={styles.tableFrame}
      data-density={tableStyle?.rowHeight ?? "small"}
      data-banded={tableStyle?.bandedRows || undefined}
      data-vertical-grid={tableStyle?.verticalGrid ?? false}
      data-preset={tableStyle?.preset ?? "spreadsheet"}
    >
      {model.missingFields.length ? (
        <p className={styles.tableMessage} role="alert">
          A field is no longer available. Remove it from the editor to update
          this pivot.
        </p>
      ) : null}
      {!config.values.length &&
      !config.rows.length &&
      !config.columns.length ? (
        <div className={styles.pivotEmpty}>
          Drag columns into Pivot rows, Pivot columns, and Values to build your
          pivot table.
        </div>
      ) : !source.rows.length ? (
        <div className={styles.pivotEmpty}>No data for this element.</div>
      ) : (
        <div className={styles.tableScroll} tabIndex={0} aria-label={title}>
          <table
            className={`${styles.table} ${styles.pivotTable}`}
            data-pivot="true"
            aria-label={`${title} pivot table`}
          >
            {config.showColumnHeaders !== false ? (
              <thead>
                <tr className={styles.pivotFixedHeaders}>
                  {rowColumnCount ? (
                    <th colSpan={rowColumnCount} className={styles.pivotCorner}>
                      {config.values.length === 1
                        ? pivotValueLabel(config.values[0]!, source.fields)
                        : ""}
                    </th>
                  ) : null}
                  <th colSpan={Math.max(1, model.columns.length)}>
                    {headerAxis
                      .filter((key) => key !== PIVOT_VALUES)
                      .map(fieldLabel)
                      .join(" / ") || "Values"}
                    <span className={styles.headerChevron}>⌄</span>
                  </th>
                </tr>
                {Array.from({ length: headerDepth }, (_, depth) => {
                  const axisKey = headerAxis[depth];
                  const axisIndex = model.columnAxis.indexOf(
                    axisKey ?? PIVOT_VALUES,
                  );
                  const cells: {
                    key: string;
                    label: string;
                    span: number;
                    entry: PivotAxisEntry;
                  }[] = [];
                  for (const column of model.columns) {
                    const path = column.path.slice(0, axisIndex + 1);
                    const key = column.total ? column.id : JSON.stringify(path);
                    const label = column.total
                      ? column.label
                      : axisIndex < 0
                        ? "Values"
                        : pathLabel(column, axisIndex);
                    const last = cells[cells.length - 1];
                    if (last?.key === key) last.span += 1;
                    else cells.push({ key, label, span: 1, entry: column });
                  }
                  return (
                    <tr
                      key={depth}
                      style={
                        {
                          "--pivot-header-top": `${(depth + 1) * 28}px`,
                        } as CSSProperties
                      }
                    >
                      {Array.from({ length: rowColumnCount }, (_, index) => (
                        <th key={index} className={styles.pivotCorner}>
                          {depth === headerDepth - 1
                            ? fieldLabel(
                                separate
                                  ? (model.rowAxis[index] ?? PIVOT_VALUES)
                                  : (model.rowAxis[0] ?? PIVOT_VALUES),
                              )
                            : ""}
                          {depth === headerDepth - 1 ? (
                            <span className={styles.headerChevron}>⌄</span>
                          ) : null}
                        </th>
                      ))}
                      {cells.map((cell) => {
                        const group = pivotGroupId(
                          "column",
                          cell.entry.path.slice(0, axisIndex + 1),
                        );
                        const canCollapse =
                          !cell.entry.total &&
                          depth < headerDepth - 1 &&
                          cell.entry.path.length >= axisIndex + 1;
                        return (
                          <th
                            key={cell.key}
                            colSpan={cell.span}
                            data-numeric="true"
                            data-total={cell.entry.total || undefined}
                          >
                            {canCollapse ? (
                              <button
                                type="button"
                                className={styles.pivotDisclosure}
                                aria-label={`${collapsed.has(group) ? "Expand" : "Collapse"} ${cell.label} columns`}
                                aria-expanded={!collapsed.has(group)}
                                onClick={() => toggle(group)}
                              >
                                {collapsed.has(group) ? "+" : "−"}
                              </button>
                            ) : null}
                            {cell.label}
                          </th>
                        );
                      })}
                    </tr>
                  );
                })}
              </thead>
            ) : null}
            <tbody>{body}</tbody>
          </table>
        </div>
      )}
      <div className={styles.tableFooter} role="status">
        <span>{source.totalRowCount.toLocaleString("en-AU")} source rows</span>
        {model.partial ? (
          <span>
            Showing {source.rows.length} of {source.totalRowCount} source rows
          </span>
        ) : (
          <span>
            {model.rows.filter((row) => !row.parent && !row.total).length} rows
          </span>
        )}
      </div>
      {ambiguous ? (
        <p className={styles.tableMessage}>
          Some cells contain multiple values. Set an aggregate in Values to
          summarize them.
        </p>
      ) : null}
    </div>
  );
}
