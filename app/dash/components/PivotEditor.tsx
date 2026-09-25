"use client";

import { useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  PIVOT_VALUES,
  PIVOT_AGGREGATE_LABELS,
  isNumericPivotField,
  pivotValueLabel,
  type DashboardPivot,
  type PivotAggregate,
  type PivotField,
  type PivotSource,
  type DashboardTableStyle,
} from "@/packages/shared/src/dashboard-pivot";
import { DashPopover } from "./DashPopover";
import { ElementEditorTabs } from "./ElementEditorTabs";
import styles from "./element-editor.module.css";

type Shelf = "rows" | "columns" | "values";
type DragField = { key: string; from: Shelf | "source" };
const SHELF_LABELS = {
  rows: "Pivot rows",
  columns: "Pivot columns",
  values: "Values",
} as const;
const MIME = "application/x-albert-pivot-field";

export function EditorIcon({
  name,
}: Readonly<{
  name:
    | "pivot"
    | "table"
    | "close"
    | "swap"
    | "search"
    | "plus"
    | "caret"
    | "grip"
    | "separate";
}>) {
  const paths: Record<typeof name, ReactNode> = {
    pivot: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <path d="M3 9h18M9 3v18M13 13h5v5M18 13l-5 5" />
      </>
    ),
    table: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="1" />
        <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    swap: (
      <>
        <path d="M5 8h14l-4-4M19 16H5l4 4M19 8v4M5 16v-4" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    caret: <path d="m7 10 5 5 5-5" />,
    grip: (
      <>
        <path
          d="M8 5v.01M16 5v.01M8 12v.01M16 12v.01M8 19v.01M16 19v.01"
          strokeWidth="3"
        />
      </>
    ),
    separate: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="1" />
        <path d="M10 4v16M3 10h18M14 14h4M14 17h4" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function FieldTypeIcon({
  field,
}: Readonly<{ field?: Pick<PivotField, "type"> }>) {
  return (
    <span className={styles.fieldType} aria-hidden="true">
      {field?.type === "date" || field?.type === "datetime" ? (
        <svg viewBox="0 0 18 18">
          <rect x="2" y="3" width="14" height="13" rx="1" />
          <path d="M2 7h14M5 1v4M13 1v4" />
          <text x="5" y="13">
            31
          </text>
        </svg>
      ) : field && isNumericPivotField(field as PivotField) ? (
        "123"
      ) : (
        "ABC"
      )}
    </span>
  );
}

export function EditorTool({
  label,
  children,
  onClick,
  pressed,
}: Readonly<{
  label: string;
  children: ReactNode;
  onClick: () => void;
  pressed?: boolean;
}>) {
  const id = useId();
  return (
    <span className={styles.tooltipWrap}>
      <button
        type="button"
        className={styles.iconButton}
        aria-label={label}
        aria-describedby={id}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </button>
      <span role="tooltip" id={id} className={styles.tooltip}>
        {label}
      </span>
    </span>
  );
}

export function PivotEditor({
  source,
  config,
  onChange,
  tableStyle,
  onStyleChange,
  sourceName,
  busy,
  additionalFields = [],
  onAddField,
}: Readonly<{
  source: PivotSource;
  config: DashboardPivot;
  onChange: (config: DashboardPivot) => void;
  tableStyle?: DashboardTableStyle;
  onStyleChange: (style: DashboardTableStyle) => void;
  sourceName: string;
  busy: boolean;
  additionalFields?: readonly PivotField[];
  onAddField?: (key: string, shelf: Shelf, config: DashboardPivot) => void;
}>) {
  const id = useId();
  const [tab, setTab] = useState<"properties" | "format">("properties");
  const [listTab, setListTab] = useState<"columns" | "metrics">("columns");
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [dragging, setDragging] = useState<DragField | null>(null);
  const activeDrag = useRef<DragField | null>(null);
  const [dropAt, setDropAt] = useState<{ shelf: Shelf; index: number } | null>(
    null,
  );
  const [menu, setMenu] = useState<{
    anchor: HTMLElement;
    field: DragField;
  } | null>(null);
  const [picker, setPicker] = useState<{
    anchor: HTMLElement;
    shelf: Shelf;
  } | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [formatKey, setFormatKey] = useState(config.values[0]?.column ?? "");
  const [aggregateMenu, setAggregateMenu] = useState(false);
  const fields = [...source.fields, ...additionalFields];
  const labelOf = (key: string) =>
    key === PIVOT_VALUES
      ? "Values"
      : (fields.find((field) => field.key === key)?.label ?? key);
  const shelfKeys = (shelf: Shelf) =>
    shelf === "values"
      ? config.values.map((value) => value.column)
      : config[shelf];
  const closeMenu = () => {
    setMenu(null);
    setAggregateMenu(false);
  };
  const remove = (field: DragField): DashboardPivot =>
    field.from === "source"
      ? config
      : field.from === "values"
        ? {
            ...config,
            values: config.values.filter((value) => value.column !== field.key),
          }
        : {
            ...config,
            [field.from]: config[field.from].filter((key) => key !== field.key),
          };
  const move = (
    field: DragField,
    target: Shelf,
    index = shelfKeys(target).length,
  ) => {
    if (field.key === PIVOT_VALUES && target === "values") return;
    let next = remove(field);
    if (target === "values") {
      const dataField = fields.find((candidate) => candidate.key === field.key);
      if (!dataField) return;
      const value = config.values.find(
        (value) => value.column === field.key,
      ) ?? {
        column: field.key,
        aggregate: isNumericPivotField(dataField)
          ? ("none" as const)
          : ("count" as const),
      };
      const values = next.values.filter((value) => value.column !== field.key);
      values.splice(
        Math.min(
          index -
            (field.from === target &&
            shelfKeys(target).indexOf(field.key) < index
              ? 1
              : 0),
          values.length,
        ),
        0,
        value,
      );
      next = { ...next, values };
    } else {
      // Axis dimensions occupy a single shelf. A source column can also be a
      // value (for example count of Product grouped by Product).
      next = {
        ...next,
        rows: next.rows.filter((key) => key !== field.key),
        columns: next.columns.filter((key) => key !== field.key),
      };
      const keys = [...next[target]];
      keys.splice(
        Math.min(
          index -
            (field.from === target &&
            shelfKeys(target).indexOf(field.key) < index
              ? 1
              : 0),
          keys.length,
        ),
        0,
        field.key,
      );
      next = { ...next, [target]: keys };
    }
    if (
      next.rows.length > 5 ||
      next.columns.length > 5 ||
      next.values.length > 12
    ) {
      setAnnouncement(
        "This shelf is full. Remove a column before adding another.",
      );
      return;
    }
    if (additionalFields.some((candidate) => candidate.key === field.key))
      onAddField?.(field.key, target, next);
    else onChange(next);
    setAnnouncement(`${labelOf(field.key)} moved to ${SHELF_LABELS[target]}.`);
    closeMenu();
    setPicker(null);
  };
  const dragStart = (event: DragEvent, field: DragField) => {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(MIME, JSON.stringify({ ...field, editor: id }));
    activeDrag.current = field;
    setDragging(field);
  };
  const dropIndex = (event: DragEvent<HTMLDivElement>, shelf: Shelf) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-pivot-index]",
    );
    return row
      ? Number(row.dataset.pivotIndex) +
        (event.clientY >
        row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
          ? 1
          : 0)
      : shelfKeys(shelf).length;
  };
  const dragOver = (event: DragEvent<HTMLDivElement>, shelf: Shelf) => {
    const active = activeDrag.current;
    if (!active || (active.key === PIVOT_VALUES && shelf === "values")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropAt({ shelf, index: dropIndex(event, shelf) });
  };
  const drop = (event: DragEvent<HTMLDivElement>, shelf: Shelf) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const field = JSON.parse(event.dataTransfer.getData(MIME));
      if (field.editor === id && activeDrag.current)
        move(
          activeDrag.current,
          shelf,
          dropIndex(event, shelf),
        );
    } catch {
      /* Ignore unrelated browser drops. */
    }
    activeDrag.current = null;
    setDragging(null);
    setDropAt(null);
  };
  const chip = (key: string, from: Shelf | "source", index?: number) => {
    const field = fields.find((field) => field.key === key);
    const value =
      from === "values"
        ? config.values.find((value) => value.column === key)
        : null;
    return (
      <div
        key={key}
        className={styles.field}
        draggable={!busy}
        data-pivot-index={index}
        data-field-key={key}
        data-field-shelf={from}
        data-placeholder={key === PIVOT_VALUES || undefined}
        data-dragging={
          (dragging?.key === key && dragging.from === from) || undefined
        }
        data-drop-before={
          (dropAt?.shelf === from && dropAt.index === index) || undefined
        }
        data-selected={
          (menu?.field.key === key && menu.field.from === from) || undefined
        }
        onDragStart={(event) => dragStart(event, { key, from })}
        onDragEnd={() => {
          activeDrag.current = null;
          setDragging(null);
          setDropAt(null);
        }}
      >
        {key === PIVOT_VALUES ? (
          <span className={styles.fieldType}>
            <EditorIcon name="pivot" />
          </span>
        ) : (
          <FieldTypeIcon field={field} />
        )}
        <button
          type="button"
          className={styles.fieldName}
          draggable={!busy}
          aria-label={`${value ? pivotValueLabel(value, fields) : labelOf(key)} in ${from === "source" ? "available columns" : SHELF_LABELS[from]}`}
          disabled={busy}
          onClick={(event) => {
            setAggregateMenu(false);
            setMenu({ anchor: event.currentTarget, field: { key, from } });
          }}
        >
          {value ? pivotValueLabel(value, fields) : labelOf(key)}
        </button>
        <span className={styles.fieldGrip} aria-hidden="true">
          <EditorIcon name="grip" />
        </span>
        <button
          type="button"
          className={styles.fieldMenu}
          aria-label={`Options for ${labelOf(key)} in ${from === "source" ? "available columns" : SHELF_LABELS[from]}`}
          disabled={busy}
          onClick={(event) => {
            setAggregateMenu(false);
            setMenu({ anchor: event.currentTarget, field: { key, from } });
          }}
        >
          <EditorIcon name="caret" />
        </button>
      </div>
    );
  };
  const formatValue =
    config.values.find((value) => value.column === formatKey) ??
    config.values[0];
  const format = (patch: Partial<NonNullable<typeof formatValue>>) =>
    formatValue &&
    onChange({
      ...config,
      values: config.values.map((value) =>
        value.column === formatValue.column ? { ...value, ...patch } : value,
      ),
    });
  const toggleOption = (
    label: string,
    key:
      | "rowTotals"
      | "columnTotals"
      | "rowSubtotals"
      | "repeatRowLabels"
      | "showRowHeaders"
      | "showColumnHeaders",
    fallback: boolean,
  ) => (
    <label className={styles.setting}>
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={config[key] ?? fallback}
        onChange={(event) =>
          onChange({ ...config, [key]: event.target.checked })
        }
      />
    </label>
  );
  const menuValue =
    menu?.field.from === "values"
      ? config.values.find((value) => value.column === menu.field.key)
      : null;
  const list = fields.filter(
    (field) =>
      (listTab === "columns" || isNumericPivotField(field)) &&
      field.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <>
      <ElementEditorTabs value={tab} onChange={setTab} id={id} />
      <div
        id={`${id}-content`}
        role="tabpanel"
        aria-labelledby={`${id}-${tab}`}
        className={styles.panelContent}
      >
        {tab === "properties" ? (
          <>
            <div className={styles.sourceSection}>
              <span className={styles.sectionLabel}>Data source</span>
              <div className={styles.sourceName}>
                <EditorIcon name="table" />
                <span>{sourceName}</span>
              </div>
            </div>
            {(["rows", "columns", "values"] as const).map((shelf) => (
              <div
                key={shelf}
                className={styles.shelf}
                role="group"
                aria-label={SHELF_LABELS[shelf]}
                data-drop-active={dropAt?.shelf === shelf || undefined}
                onDragOver={(event) => dragOver(event, shelf)}
                onDragEnter={(event) => dragOver(event, shelf)}
                onDrop={(event) => drop(event, shelf)}
              >
                <div className={styles.sectionHeading}>
                  <span className={styles.sectionLabel}>
                    {SHELF_LABELS[shelf]}
                  </span>
                  <span className={styles.sectionTools}>
                    {shelf === "rows" ? (
                      <>
                        <EditorTool
                          label="Swap rows with columns"
                          onClick={() =>
                            onChange({
                              ...config,
                              rows: config.columns,
                              columns: config.rows,
                            })
                          }
                        >
                          <EditorIcon name="swap" />
                        </EditorTool>
                        {config.rows.length > 1 ? (
                          <EditorTool
                            label={
                              config.rowLayout === "separate"
                                ? "Display as a single column"
                                : "Display as separate columns"
                            }
                            pressed={config.rowLayout === "separate"}
                            onClick={() =>
                              onChange({
                                ...config,
                                rowLayout:
                                  config.rowLayout === "separate"
                                    ? "single"
                                    : "separate",
                              })
                            }
                          >
                            <EditorIcon name="separate" />
                          </EditorTool>
                        ) : null}
                      </>
                    ) : null}
                    <button
                      className={styles.iconButton}
                      type="button"
                      aria-label={`Add column to ${SHELF_LABELS[shelf]}`}
                      disabled={busy}
                      onClick={(event) => {
                        setPicker({ anchor: event.currentTarget, shelf });
                        setPickerSearch("");
                      }}
                    >
                      <EditorIcon name="plus" />
                    </button>
                  </span>
                </div>
                <div className={styles.shelfFields}>
                  {shelfKeys(shelf).map((key, index) =>
                    chip(key, shelf, index),
                  )}
                  <div
                    className={styles.dropTarget}
                    data-drop-before={
                      (dropAt?.shelf === shelf &&
                        dropAt.index === shelfKeys(shelf).length) ||
                      undefined
                    }
                    data-empty={shelfKeys(shelf).length === 0 || undefined}
                  >
                    {shelfKeys(shelf).length === 0 ? "Drag columns here" : null}
                  </div>
                </div>
              </div>
            ))}
            <div className={styles.available}>
              <div
                className={styles.columnTabs}
                role="group"
                aria-label="Available fields"
              >
                <button
                  type="button"
                  aria-pressed={listTab === "columns"}
                  onClick={() => setListTab("columns")}
                >
                  Columns
                </button>
                <button
                  type="button"
                  aria-pressed={listTab === "metrics"}
                  onClick={() => setListTab("metrics")}
                >
                  Metrics
                </button>
              </div>
              <div className={styles.sectionHeading}>
                <span className={styles.sectionLabel}>Add column</span>
                <EditorTool
                  label="Search columns"
                  onClick={() => setSearchOpen(!searchOpen)}
                >
                  <EditorIcon name="search" />
                </EditorTool>
              </div>
              {searchOpen ? (
                <input
                  autoFocus
                  className={styles.search}
                  aria-label="Search columns"
                  placeholder="Search columns"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              ) : null}
              <div className={styles.availableFields}>
                {list.map((field) => chip(field.key, "source"))}
                {!list.length ? (
                  <p className={styles.hint}>No columns found.</p>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <div className={styles.formatSections}>
            <details open>
              <summary>Table style</summary>
              <div className={styles.settings}>
                <label className={styles.setting}>
                  <span>Preset</span>
                  <select
                    aria-label="Table style"
                    value={tableStyle?.preset ?? "spreadsheet"}
                    onChange={(event) =>
                      onStyleChange({
                        ...tableStyle,
                        preset: event.target.value as
                          "spreadsheet" | "presentation",
                        rowHeight:
                          event.target.value === "presentation"
                            ? "large"
                            : "small",
                        verticalGrid: event.target.value === "spreadsheet",
                        bandedRows: false,
                      })
                    }
                  >
                    <option value="spreadsheet">Spreadsheet</option>
                    <option value="presentation">Presentation</option>
                  </select>
                </label>
                <label className={styles.setting}>
                  <span>Cell spacing</span>
                  <select
                    aria-label="Cell spacing"
                    value={tableStyle?.rowHeight ?? "small"}
                    onChange={(event) =>
                      onStyleChange({
                        ...tableStyle,
                        rowHeight: event.target.value as
                          "small" | "medium" | "large",
                      })
                    }
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </label>
                <label className={styles.setting}>
                  <span>Banded rows</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Banded rows"
                    checked={tableStyle?.bandedRows ?? false}
                    onChange={(event) =>
                      onStyleChange({
                        ...tableStyle,
                        bandedRows: event.target.checked,
                      })
                    }
                  />
                </label>
                <label className={styles.setting}>
                  <span>Vertical gridlines</span>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label="Vertical gridlines"
                    checked={tableStyle?.verticalGrid ?? false}
                    onChange={(event) =>
                      onStyleChange({
                        ...tableStyle,
                        verticalGrid: event.target.checked,
                      })
                    }
                  />
                </label>
              </div>
            </details>
            <details open>
              <summary>Totals</summary>
              <div className={styles.settings}>
                {toggleOption("Grand total row", "rowTotals", false)}
                {toggleOption("Grand total column", "columnTotals", false)}
                {toggleOption("Row subtotals", "rowSubtotals", true)}
              </div>
            </details>
            <details>
              <summary>Table components</summary>
              <div className={styles.settings}>
                {toggleOption("Show column headers", "showColumnHeaders", true)}
                {toggleOption("Show row headers", "showRowHeaders", true)}
              </div>
            </details>
            <details open>
              <summary>Format</summary>
              <div className={styles.settings}>
                {toggleOption("Repeat row labels", "repeatRowLabels", false)}
                <label className={styles.setting}>
                  <span>Empty cell display value</span>
                  <input
                    aria-label="Empty cell display value"
                    maxLength={40}
                    key={config.emptyValue ?? ""}
                    defaultValue={config.emptyValue ?? ""}
                    onBlur={(event) => {
                      if (event.target.value !== (config.emptyValue ?? ""))
                        onChange({ ...config, emptyValue: event.target.value });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                </label>
                {formatValue ? (
                  <>
                    <label className={styles.setting}>
                      <span>Value</span>
                      <select
                        aria-label="Format value"
                        value={formatValue.column}
                        onChange={(event) => setFormatKey(event.target.value)}
                      >
                        {config.values.map((value) => (
                          <option key={value.column} value={value.column}>
                            {pivotValueLabel(value, fields)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.setting}>
                      <span>Name</span>
                      <input
                        key={formatValue.column}
                        aria-label="Value name"
                        maxLength={160}
                        defaultValue={pivotValueLabel(formatValue, fields)}
                        onBlur={(event) => {
                          const label = event.target.value.trim();
                          if (
                            label &&
                            label !== pivotValueLabel(formatValue, fields)
                          )
                            format({ label });
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </label>
                    <label className={styles.setting}>
                      <span>Number format</span>
                      <select
                        aria-label="Value format"
                        value={formatValue.format ?? "auto"}
                        onChange={(event) => {
                          const next = { ...formatValue };
                          if (event.target.value === "auto") delete next.format;
                          else
                            next.format = event.target
                              .value as typeof next.format;
                          onChange({
                            ...config,
                            values: config.values.map((value) =>
                              value.column === next.column ? next : value,
                            ),
                          });
                        }}
                      >
                        <option value="auto">Automatic</option>
                        <option value="number">Number</option>
                        <option value="currency">Currency</option>
                        <option value="percent">Percent</option>
                        <option value="text">Text</option>
                      </select>
                    </label>
                    <label className={styles.setting}>
                      <span>Decimals</span>
                      <select
                        aria-label="Decimal places"
                        value={formatValue.decimals ?? "auto"}
                        onChange={(event) => {
                          const next = { ...formatValue };
                          if (event.target.value === "auto")
                            delete next.decimals;
                          else next.decimals = Number(event.target.value);
                          onChange({
                            ...config,
                            values: config.values.map((value) =>
                              value.column === next.column ? next : value,
                            ),
                          });
                        }}
                      >
                        <option value="auto">Automatic</option>
                        {Array.from({ length: 7 }, (_, index) => (
                          <option key={index} value={index}>
                            {index}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}
              </div>
            </details>
          </div>
        )}
      </div>
      <span className={styles.srOnly} role="status">
        {announcement}
      </span>
      <DashPopover
        anchor={menu?.anchor ?? null}
        open={menu !== null}
        onClose={closeMenu}
        label={
          menu ? `${labelOf(menu.field.key)} field options` : "Field options"
        }
        role="menu"
        width={248}
      >
        {menu ? (
          <div className={styles.menu}>
            {aggregateMenu && menuValue ? (
              <>
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => setAggregateMenu(false)}
                >
                  ‹ Set aggregate
                </button>
                <span className={styles.menuDivider} />
                {(
                  Object.entries(PIVOT_AGGREGATE_LABELS) as [
                    PivotAggregate,
                    string,
                  ][]
                ).map(([aggregate, label]) => (
                  <button
                    key={aggregate}
                    type="button"
                    role="menuitemradio"
                    aria-checked={menuValue.aggregate === aggregate}
                    className={styles.menuItem}
                    onClick={() => {
                      onChange({
                        ...config,
                        values: config.values.map((value) =>
                          value.column === menuValue.column
                            ? { ...value, aggregate }
                            : value,
                        ),
                      });
                      closeMenu();
                    }}
                  >
                    {label}
                    <span aria-hidden="true">
                      {menuValue.aggregate === aggregate ? "✓" : ""}
                    </span>
                  </button>
                ))}
              </>
            ) : (
              <>
                {menuValue ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => setAggregateMenu(true)}
                    >
                      Set aggregate<span aria-hidden="true">›</span>
                    </button>
                    <span className={styles.menuDivider} />
                  </>
                ) : null}
                {(["rows", "columns", "values"] as const)
                  .filter(
                    (shelf) =>
                      shelf !== menu.field.from &&
                      !(shelf === "values" && menu.field.key === PIVOT_VALUES),
                  )
                  .map((shelf) => (
                    <button
                      key={shelf}
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => move(menu.field, shelf)}
                    >
                      Move to {SHELF_LABELS[shelf]}
                    </button>
                  ))}
                {menu.field.from !== "source" ? (
                  <>
                    <span className={styles.menuDivider} />
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      disabled={
                        shelfKeys(menu.field.from).indexOf(menu.field.key) === 0
                      }
                      onClick={() =>
                        move(
                          menu.field,
                          menu.field.from as Shelf,
                          shelfKeys(menu.field.from as Shelf).indexOf(
                            menu.field.key,
                          ) - 1,
                        )
                      }
                    >
                      Move up
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      disabled={
                        shelfKeys(menu.field.from).indexOf(menu.field.key) ===
                        shelfKeys(menu.field.from).length - 1
                      }
                      onClick={() =>
                        move(
                          menu.field,
                          menu.field.from as Shelf,
                          shelfKeys(menu.field.from as Shelf).indexOf(
                            menu.field.key,
                          ) + 2,
                        )
                      }
                    >
                      Move down
                    </button>
                    {menu.field.from !== "values" &&
                    menu.field.key !== PIVOT_VALUES ? (
                      <>
                        <span className={styles.menuDivider} />
                        {(["asc", "desc"] as const).map((direction) => (
                          <button
                            key={direction}
                            type="button"
                            role="menuitem"
                            className={styles.menuItem}
                            onClick={() => {
                              onChange({
                                ...config,
                                sort: [
                                  ...(config.sort ?? []).filter(
                                    (sort) => sort.column !== menu.field.key,
                                  ),
                                  { column: menu.field.key, direction },
                                ].slice(-8),
                              });
                              closeMenu();
                            }}
                          >
                            Sort{" "}
                            {direction === "asc" ? "ascending" : "descending"}
                          </button>
                        ))}
                      </>
                    ) : null}
                    <span className={styles.menuDivider} />
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => {
                        onChange(remove(menu.field));
                        closeMenu();
                      }}
                    >
                      Remove column
                    </button>
                  </>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </DashPopover>
      <DashPopover
        anchor={picker?.anchor ?? null}
        open={picker !== null}
        onClose={() => setPicker(null)}
        label={`Add column to ${picker ? SHELF_LABELS[picker.shelf] : "pivot"}`}
        width={280}
      >
        <div className={styles.picker}>
          <input
            autoFocus
            className={styles.search}
            aria-label="Find a column"
            placeholder="Search columns"
            value={pickerSearch}
            onChange={(event) => setPickerSearch(event.target.value)}
          />
          <div className={styles.pickerList}>
            {picker &&
            picker.shelf !== "values" &&
            ![...config.rows, ...config.columns].includes(PIVOT_VALUES) ? (
              <button
                type="button"
                className={styles.menuItem}
                onClick={() =>
                  move({ key: PIVOT_VALUES, from: "source" }, picker.shelf)
                }
              >
                Values
              </button>
            ) : null}
            {fields
              .filter(
                (field) =>
                  field.label
                    .toLocaleLowerCase()
                    .includes(pickerSearch.toLocaleLowerCase()) &&
                  picker &&
                  !shelfKeys(picker.shelf).includes(field.key),
              )
              .map((field) => (
                <button
                  key={field.key}
                  type="button"
                  className={styles.menuItem}
                  onClick={() =>
                    picker &&
                    move({ key: field.key, from: "source" }, picker.shelf)
                  }
                >
                  <FieldTypeIcon field={field} />
                  {field.label}
                </button>
              ))}
          </div>
        </div>
      </DashPopover>
    </>
  );
}
