"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./my-data-workspace.module.css";

type MyDataTableSummary = Readonly<{
  name: string;
  approximateRows: number;
  columnCount: number;
  available: boolean;
}>;

type MyDataSource = Readonly<{
  connectionId: string;
  schemaName: string;
  service: string;
  displayName: string;
  status: string;
  tables: readonly MyDataTableSummary[];
}>;

type MyDataCatalogue = Readonly<{
  checkedAt: string;
  totalRows: number;
  sources: readonly MyDataSource[];
}>;

type MyDataColumn = Readonly<{
  name: string;
  dataType: string;
}>;

type MyDataTablePage = Readonly<{
  schemaName: string;
  tableName: string;
  columns: readonly MyDataColumn[];
  rows: readonly Readonly<Record<string, string | null>>[];
  offset: number;
  limit: number;
  hasMore: boolean;
  approximateRows: number;
  excludedColumnCount: number;
  additionalColumnCount: number;
  cellCharacterLimit: number;
}>;

type Selection = Readonly<{
  connectionId: string;
  schemaName: string;
  tableName: string;
}>;

type RowsState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; table: MyDataTablePage }>;

type VisibleSource = Readonly<{
  source: MyDataSource;
  tables: readonly MyDataTableSummary[];
}>;

const PAGE_SIZES = [25, 50] as const;
const integerFormatter = new Intl.NumberFormat("en-AU");
const compactFormatter = new Intl.NumberFormat("en-AU", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const checkedAtFormatter = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseTableSummary(value: unknown): MyDataTableSummary | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim()) return null;
  if (!isNonnegativeInteger(value.approximateRows) || !isNonnegativeInteger(value.columnCount)) return null;
  if (typeof value.available !== "boolean") return null;
  return {
    name: value.name,
    approximateRows: value.approximateRows,
    columnCount: value.columnCount,
    available: value.available,
  };
}

function parseSource(value: unknown): MyDataSource | null {
  if (!isRecord(value) || !Array.isArray(value.tables)) return null;
  if (
    typeof value.connectionId !== "string" || !value.connectionId.trim()
    || typeof value.schemaName !== "string" || !value.schemaName.trim()
    || typeof value.service !== "string" || !value.service.trim()
    || typeof value.displayName !== "string" || !value.displayName.trim()
    || typeof value.status !== "string" || !value.status.trim()
  ) return null;
  const tables = value.tables.map(parseTableSummary);
  if (tables.some((table) => table === null)) return null;
  return {
    connectionId: value.connectionId,
    schemaName: value.schemaName,
    service: value.service,
    displayName: value.displayName,
    status: value.status,
    tables: tables as MyDataTableSummary[],
  };
}

function parseCatalogue(value: unknown): MyDataCatalogue | null {
  if (!isRecord(value) || !Array.isArray(value.sources)) return null;
  if (typeof value.checkedAt !== "string" || !value.checkedAt.trim()) return null;
  if (!isNonnegativeInteger(value.totalRows)) return null;
  const sources = value.sources.map(parseSource);
  if (sources.some((source) => source === null)) return null;
  return {
    checkedAt: value.checkedAt,
    totalRows: value.totalRows,
    sources: sources as MyDataSource[],
  };
}

function parseTablePage(value: unknown): MyDataTablePage | null {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return null;
  if (
    typeof value.schemaName !== "string" || !value.schemaName.trim()
    || typeof value.tableName !== "string" || !value.tableName.trim()
    || !isNonnegativeInteger(value.offset)
    || !isNonnegativeInteger(value.limit) || value.limit === 0
    || typeof value.hasMore !== "boolean"
    || !isNonnegativeInteger(value.approximateRows)
    || !isNonnegativeInteger(value.excludedColumnCount)
    || !isNonnegativeInteger(value.additionalColumnCount)
    || !isNonnegativeInteger(value.cellCharacterLimit) || value.cellCharacterLimit === 0
  ) return null;

  const columns: MyDataColumn[] = [];
  const columnNames = new Set<string>();
  for (const candidate of value.columns) {
    if (!isRecord(candidate) || typeof candidate.name !== "string" || !candidate.name.trim()
      || typeof candidate.dataType !== "string" || !candidate.dataType.trim()
      || columnNames.has(candidate.name)) return null;
    columnNames.add(candidate.name);
    columns.push({ name: candidate.name, dataType: candidate.dataType });
  }

  const rows: Array<Readonly<Record<string, string | null>>> = [];
  for (const candidate of value.rows) {
    if (!isRecord(candidate)) return null;
    const row: Record<string, string | null> = {};
    for (const column of columns) {
      const cell = candidate[column.name];
      if (cell !== undefined && cell !== null && typeof cell !== "string") return null;
      row[column.name] = cell === undefined ? null : cell;
    }
    rows.push(row);
  }
  if (rows.length > value.limit) return null;

  return {
    schemaName: value.schemaName,
    tableName: value.tableName,
    columns,
    rows,
    offset: value.offset,
    limit: value.limit,
    hasMore: value.hasMore,
    approximateRows: value.approximateRows,
    excludedColumnCount: value.excludedColumnCount,
    additionalColumnCount: value.additionalColumnCount,
    cellCharacterLimit: value.cellCharacterLimit,
  };
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function serviceLabel(service: string): string {
  if (service === "xero") return "Xero";
  if (service === "light_speed_retail") return "Lightspeed Retail";
  if (service === "deputy") return "Deputy";
  return humanize(service);
}

function statusTone(status: string): "healthy" | "pending" | "warning" | "neutral" {
  const normalized = status.toLowerCase();
  if (/active|connected|healthy|ready|synced|succeeded/u.test(normalized)) return "healthy";
  if (/loading|sync|pending|scheduled|historical|incremental/u.test(normalized)) return "pending";
  if (/error|fail|blocked|broken|paused|degraded/u.test(normalized)) return "warning";
  return "neutral";
}

function sourceKey(source: Pick<MyDataSource, "connectionId" | "schemaName">): string {
  return `${source.connectionId}:${source.schemaName}`;
}

function sameSelection(left: Selection | null, right: Selection | null): boolean {
  return left?.connectionId === right?.connectionId
    && left?.schemaName === right?.schemaName
    && left?.tableName === right?.tableName;
}

function selectionExists(catalogue: MyDataCatalogue, selection: Selection | null): boolean {
  if (!selection) return false;
  return catalogue.sources.some((source) => (
    source.connectionId === selection.connectionId
    && source.schemaName === selection.schemaName
    && source.tables.some((table) => table.name === selection.tableName)
  ));
}

function firstSelection(catalogue: MyDataCatalogue): Selection | null {
  for (const source of catalogue.sources) {
    const table = source.tables.find((candidate) => candidate.available);
    if (table) return {
      connectionId: source.connectionId,
      schemaName: source.schemaName,
      tableName: table.name,
    };
  }
  for (const source of catalogue.sources) {
    const table = source.tables[0];
    if (table) return {
      connectionId: source.connectionId,
      schemaName: source.schemaName,
      tableName: table.name,
    };
  }
  return null;
}

function formatCheckedAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? checkedAtFormatter.format(new Date(timestamp)) : "Unavailable";
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 5 5" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 7v5h-5" />
      <path d="M18.5 16a8 8 0 1 1 .5-9l1 5" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
      <path d="M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" />
    </svg>
  );
}

function ChevronIcon({ open }: Readonly<{ open: boolean }>) {
  return (
    <svg className={styles.chevron} data-open={open ? "true" : undefined} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function WorkspaceState({
  kind,
  title,
  description,
  action,
}: Readonly<{
  kind: "loading" | "error" | "empty" | "access";
  title: string;
  description: string;
  action?: Readonly<{ label: string; onClick: () => void }>;
}>) {
  return (
    <div
      className={styles.workspaceState}
      data-kind={kind}
      role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}
    >
      <span className={styles.workspaceStateIcon} aria-hidden="true">
        {kind === "loading" ? <i className={styles.spinner} /> : <DatabaseIcon />}
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <button type="button" onClick={action.onClick}>{action.label}</button> : null}
    </div>
  );
}

async function responseJson(response: Response): Promise<Record<string, unknown> | null> {
  const value = await response.json().catch(() => null) as unknown;
  return isRecord(value) ? value : null;
}

function responseError(payload: Record<string, unknown> | null, fallback: string): Error {
  return new Error(typeof payload?.error === "string" && payload.error.trim() ? payload.error : fallback);
}

export default function MyDataWorkspace() {
  const [catalogue, setCatalogue] = useState<MyDataCatalogue | null>(null);
  const searchId = useId();
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [catalogueError, setCatalogueError] = useState("");
  const [catalogueRevision, setCatalogueRevision] = useState(0);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const [collapsedSchemas, setCollapsedSchemas] = useState<ReadonlySet<string>>(() => new Set());
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState<(typeof PAGE_SIZES)[number]>(25);
  const [rowsRevision, setRowsRevision] = useState(0);
  const [rowsState, setRowsState] = useState<RowsState>({ kind: "idle" });
  const catalogueRequestRef = useRef(0);
  const rowsRequestRef = useRef(0);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++catalogueRequestRef.current;

    void fetch("/api/my-data", {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await responseJson(response);
      if (!response.ok) throw responseError(payload, "Your data catalogue could not be loaded.");
      const parsed = parseCatalogue(payload?.catalogue);
      if (!parsed) throw new Error("Your data catalogue returned an invalid response.");
      if (controller.signal.aborted || requestId !== catalogueRequestRef.current) return;

      const current = selectionRef.current;
      const nextSelection = selectionExists(parsed, current) ? current : firstSelection(parsed);
      setCatalogue(parsed);
      if (!sameSelection(current, nextSelection)) {
        rowsRequestRef.current += 1;
        selectionRef.current = nextSelection;
        setSelection(nextSelection);
        setOffset(0);
      }
      const nextSource = nextSelection
        ? parsed.sources.find((source) => (
          source.connectionId === nextSelection.connectionId
          && source.schemaName === nextSelection.schemaName
        ))
        : undefined;
      const nextTable = nextSource?.tables.find((table) => table.name === nextSelection?.tableName);
      setRowsState(nextTable?.available ? { kind: "loading" } : { kind: "idle" });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || requestId !== catalogueRequestRef.current) return;
      setCatalogueError(error instanceof Error ? error.message : "Your data catalogue could not be loaded.");
    }).finally(() => {
      if (!controller.signal.aborted && requestId === catalogueRequestRef.current) {
        setCatalogueLoading(false);
      }
    });

    return () => controller.abort();
  }, [catalogueRevision]);

  const selectedContext = useMemo(() => {
    if (!catalogue || !selection) return null;
    const source = catalogue.sources.find((candidate) => (
      candidate.connectionId === selection.connectionId
      && candidate.schemaName === selection.schemaName
    ));
    const table = source?.tables.find((candidate) => candidate.name === selection.tableName);
    return source && table ? { source, table } : null;
  }, [catalogue, selection]);

  const selectedAvailable = selectedContext?.table.available === true;
  const selectedConnectionId = selection?.connectionId ?? "";
  const selectedSchemaName = selection?.schemaName ?? "";
  const selectedTableName = selection?.tableName ?? "";

  useEffect(() => {
    if (!selectedConnectionId || !selectedSchemaName || !selectedTableName || !selectedAvailable) {
      return;
    }

    const controller = new AbortController();
    const requestId = ++rowsRequestRef.current;
    const requested = {
      connectionId: selectedConnectionId,
      schemaName: selectedSchemaName,
      tableName: selectedTableName,
      offset,
      limit,
    };

    void fetch("/api/my-data/rows", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        schemaName: requested.schemaName,
        tableName: requested.tableName,
        offset: requested.offset,
        limit: requested.limit,
      }),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
    }).then(async (response) => {
      const payload = await responseJson(response);
      if (!response.ok) throw responseError(payload, "The selected table could not be loaded.");
      const parsed = parseTablePage(payload?.table);
      if (!parsed
        || parsed.schemaName !== requested.schemaName
        || parsed.tableName !== requested.tableName
        || parsed.offset !== requested.offset
        || parsed.limit !== requested.limit) {
        throw new Error("The selected table returned an invalid response.");
      }
      if (controller.signal.aborted || requestId !== rowsRequestRef.current) return;
      setRowsState({ kind: "ready", table: parsed });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || requestId !== rowsRequestRef.current) return;
      setRowsState({
        kind: "error",
        message: error instanceof Error ? error.message : "The selected table could not be loaded.",
      });
    });

    return () => controller.abort();
  }, [limit, offset, rowsRevision, selectedAvailable, selectedConnectionId, selectedSchemaName, selectedTableName]);

  const visibleSources = useMemo<readonly VisibleSource[]>(() => {
    if (!catalogue) return [];
    if (!deferredQuery) return catalogue.sources.map((source) => ({ source, tables: source.tables }));
    return catalogue.sources.flatMap((source) => {
      const sourceHaystack = [
        source.displayName,
        source.schemaName,
        source.service,
        serviceLabel(source.service),
        source.status,
      ].join(" ").toLowerCase();
      const sourceMatches = sourceHaystack.includes(deferredQuery);
      const tables = source.tables.filter((table) => (
        sourceMatches || `${table.name} ${humanize(table.name)}`.toLowerCase().includes(deferredQuery)
      ));
      return sourceMatches || tables.length > 0 ? [{ source, tables }] : [];
    });
  }, [catalogue, deferredQuery]);

  const summary = useMemo(() => {
    const sources = catalogue?.sources ?? [];
    return {
      sources: sources.length,
      schemas: new Set(sources.map((source) => source.schemaName)).size,
      tables: sources.reduce((total, source) => total + source.tables.length, 0),
      availableTables: sources.reduce(
        (total, source) => total + source.tables.filter((table) => table.available).length,
        0,
      ),
    };
  }, [catalogue]);

  const toggleSchema = useCallback((source: MyDataSource) => {
    const key = sourceKey(source);
    setCollapsedSchemas((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const chooseTable = useCallback((source: MyDataSource, table: MyDataTableSummary) => {
    const next = {
      connectionId: source.connectionId,
      schemaName: source.schemaName,
      tableName: table.name,
    };
    if (!sameSelection(selectionRef.current, next)) {
      rowsRequestRef.current += 1;
      selectionRef.current = next;
      setSelection(next);
      setOffset(0);
      setRowsState(table.available ? { kind: "loading" } : { kind: "idle" });
    }
  }, []);

  const refreshCatalogue = useCallback(() => {
    catalogueRequestRef.current += 1;
    rowsRequestRef.current += 1;
    setCatalogueLoading(true);
    setCatalogueError("");
    if (selectedAvailable) setRowsState({ kind: "loading" });
    setCatalogueRevision((current) => current + 1);
    setRowsRevision((current) => current + 1);
  }, [selectedAvailable]);

  const refreshRows = useCallback(() => {
    rowsRequestRef.current += 1;
    if (selectedAvailable) setRowsState({ kind: "loading" });
    setRowsRevision((current) => current + 1);
  }, [selectedAvailable]);

  if (!catalogue && catalogueLoading) {
    return (
      <section className={styles.workspace} aria-label="My Data" aria-busy="true">
        <WorkspaceState
          kind="loading"
          title="Loading your data catalogue"
          description="Checking the schemas and tables that Fivetran has made available to this organisation."
        />
      </section>
    );
  }

  if (!catalogue) {
    return (
      <section className={styles.workspace} aria-label="My Data">
        <WorkspaceState
          kind="error"
          title="Your data catalogue is unavailable"
          description={catalogueError || "Albert could not load your connected schemas right now."}
          action={{ label: "Try again", onClick: refreshCatalogue }}
        />
      </section>
    );
  }

  if (catalogue.sources.length === 0) {
    return (
      <section className={styles.workspace} aria-label="My Data">
        <WorkspaceState
          kind="empty"
          title="No Fivetran data has landed yet"
          description="Connect Xero, Lightspeed Retail, or Deputy and start its first sync. Schemas and tables will appear here as data lands."
          action={{ label: catalogueLoading ? "Checking…" : "Refresh", onClick: refreshCatalogue }}
        />
      </section>
    );
  }

  const readyTable = rowsState.kind === "ready" ? rowsState.table : null;
  const fromRow = readyTable && readyTable.rows.length > 0 ? readyTable.offset + 1 : 0;
  const throughRow = readyTable ? readyTable.offset + readyTable.rows.length : 0;
  const pageNumber = Math.floor(offset / limit) + 1;

  return (
    <section className={styles.workspace} aria-label="My Data" aria-busy={catalogueLoading || rowsState.kind === "loading"}>
      <div className={styles.summaryBar}>
        <dl className={styles.summaryValues} aria-label="Connected data summary">
          <div><dt>Sources</dt><dd>{summary.sources}</dd></div>
          <div><dt>Schemas</dt><dd>{summary.schemas}</dd></div>
          <div><dt>Tables</dt><dd>{summary.tables}</dd></div>
          <div><dt>Available</dt><dd>{summary.availableTables}</dd></div>
          <div><dt>Rows</dt><dd title={integerFormatter.format(catalogue.totalRows)}>≈{compactFormatter.format(catalogue.totalRows)}</dd></div>
        </dl>
        <div className={styles.summaryActions}>
          <span>Checked {formatCheckedAt(catalogue.checkedAt)}</span>
          <button type="button" onClick={refreshCatalogue} disabled={catalogueLoading}>
            <RefreshIcon />
            {catalogueLoading ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </div>

      {catalogueError ? (
        <div className={styles.inlineNotice} role="alert">
          <span>{catalogueError}</span>
          <button type="button" onClick={refreshCatalogue}>Retry</button>
        </div>
      ) : null}

      <div className={styles.catalogueLayout}>
        <aside className={styles.catalogueRail} aria-label="Schemas and tables">
          <div className={styles.railHeader}>
            <div>
              <strong>Data catalogue</strong>
              <span>Fivetran schemas</span>
            </div>
            <div className={styles.searchField}>
              <label className={styles.srOnly} htmlFor={searchId}>Search schemas and tables</label>
              <SearchIcon />
              <input
                id={searchId}
                type="search"
                value={query}
                placeholder="Search schemas or tables"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button type="button" aria-label="Clear catalogue search" onClick={() => setQuery("")}>×</button>
              ) : null}
            </div>
          </div>

          <nav className={styles.sourceList} aria-label="Connected Fivetran schemas">
            {visibleSources.length > 0 ? visibleSources.map(({ source, tables }) => {
              const key = sourceKey(source);
              const collapsed = !deferredQuery && collapsedSchemas.has(key);
              return (
                <section className={styles.sourceGroup} key={key}>
                  <button
                    className={styles.schemaButton}
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleSchema(source)}
                  >
                    <span className={styles.sourceMark} aria-hidden="true">{serviceLabel(source.service).charAt(0)}</span>
                    <span className={styles.schemaCopy}>
                      <strong>{source.displayName}</strong>
                      <code>{source.schemaName}</code>
                    </span>
                    <span className={styles.schemaMeta}>
                      <span data-tone={statusTone(source.status)}>{humanize(source.status)}</span>
                      <small>{source.tables.length}</small>
                    </span>
                    <ChevronIcon open={!collapsed} />
                  </button>
                  {!collapsed ? (
                    <div className={styles.tableList}>
                      {tables.map((table) => {
                        const selected = selection?.connectionId === source.connectionId
                          && selection.schemaName === source.schemaName
                          && selection.tableName === table.name;
                        return (
                          <button
                            type="button"
                            className={styles.tableButton}
                            aria-current={selected ? "page" : undefined}
                            data-available={table.available ? "true" : "false"}
                            key={table.name}
                            onClick={() => chooseTable(source, table)}
                          >
                            <span className={styles.tableGlyph} aria-hidden="true" />
                            <span className={styles.tableName} title={table.name}>{table.name}</span>
                            <span className={styles.tableCount}>
                              {table.available ? `≈${compactFormatter.format(table.approximateRows)}` : "Unavailable"}
                            </span>
                          </button>
                        );
                      })}
                      {tables.length === 0 ? <p className={styles.railEmpty}>No matching tables</p> : null}
                    </div>
                  ) : null}
                </section>
              );
            }) : (
              <p className={styles.railEmpty}>No schemas or tables match “{query.trim()}”.</p>
            )}
          </nav>

          <p className={styles.railFooter}>
            Read only · system, tenant, and credential-bearing columns stay hidden
          </p>
        </aside>

        <section className={styles.dataPane} aria-labelledby="my-data-table-title">
          {selectedContext ? (
            <>
              <header className={styles.dataHeader}>
                <div className={styles.dataIdentity}>
                  <div className={styles.breadcrumbs} aria-label="Selected data table">
                    <span>{serviceLabel(selectedContext.source.service)}</span>
                    <i aria-hidden="true">/</i>
                    <code>{selectedContext.source.schemaName}</code>
                  </div>
                  <h2 id="my-data-table-title">{selectedContext.table.name}</h2>
                  <p>
                    Approximately {integerFormatter.format(selectedContext.table.approximateRows)} rows
                    <span aria-hidden="true"> · </span>
                    {selectedContext.table.columnCount} {selectedContext.table.columnCount === 1 ? "column" : "columns"}
                  </p>
                </div>
                <div className={styles.dataActions}>
                  <label>
                    <span>Rows per page</span>
                    <select
                      value={limit}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        if (next === 25 || next === 50) {
                          rowsRequestRef.current += 1;
                          setRowsState({ kind: "loading" });
                          setLimit(next);
                          setOffset(0);
                        }
                      }}
                    >
                      {PAGE_SIZES.map((size) => <option value={size} key={size}>{size} rows</option>)}
                    </select>
                  </label>
                  <button type="button" onClick={refreshRows} disabled={!selectedContext.table.available || rowsState.kind === "loading"}>
                    <RefreshIcon />
                    Refresh table
                  </button>
                </div>
              </header>

              {!selectedContext.table.available ? (
                <WorkspaceState
                  kind="access"
                  title="This table is not available yet"
                  description="Fivetran reported this table, but its data has not landed or is not currently available to this organisation."
                />
              ) : rowsState.kind === "loading" ? (
                <WorkspaceState
                  kind="loading"
                  title="Loading table rows"
                  description={`Reading a tenant-scoped page from ${selectedContext.table.name}.`}
                />
              ) : rowsState.kind === "error" ? (
                <WorkspaceState
                  kind="error"
                  title="This table could not be loaded"
                  description={rowsState.message}
                  action={{ label: "Try again", onClick: refreshRows }}
                />
              ) : readyTable && readyTable.columns.length === 0 ? (
                <WorkspaceState
                  kind="access"
                  title="No columns can be displayed"
                  description="Every column in this table is system-owned, tenant-scoping, credential-bearing, or otherwise protected."
                />
              ) : readyTable && readyTable.rows.length === 0 ? (
                <WorkspaceState
                  kind="empty"
                  title="This table has no rows"
                  description="The table is available, but Fivetran has not landed any rows for this organisation."
                />
              ) : readyTable ? (
                <div className={styles.tableRegion}>
                  <div
                    className={styles.tableViewport}
                    tabIndex={0}
                    aria-label={`Scrollable data from ${readyTable.schemaName}.${readyTable.tableName}`}
                  >
                    <table>
                      <caption className={styles.srOnly}>
                        Data from {readyTable.schemaName}.{readyTable.tableName}
                      </caption>
                      <thead>
                        <tr>
                          {readyTable.columns.map((column) => (
                            <th scope="col" key={column.name}>
                              <span>{column.name}</span>
                              <small>{column.dataType}</small>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {readyTable.rows.map((row, rowIndex) => (
                          <tr key={readyTable.offset + rowIndex}>
                            {readyTable.columns.map((column) => {
                              const value = row[column.name];
                              return (
                                <td key={column.name} title={value ?? "Null"}>
                                  {value === null
                                    ? <span className={styles.nullValue}>NULL</span>
                                    : <span>{value}</span>}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className={styles.tableNotice}>
                    <span>
                      {readyTable.excludedColumnCount > 0
                        ? `${readyTable.excludedColumnCount} protected ${readyTable.excludedColumnCount === 1 ? "column" : "columns"} hidden`
                        : "Protected columns are hidden when present"}
                      {readyTable.additionalColumnCount > 0 ? (
                        <>
                          <span aria-hidden="true"> · </span>
                          {readyTable.additionalColumnCount} additional {readyTable.additionalColumnCount === 1 ? "column" : "columns"} not shown
                        </>
                      ) : null}
                      <span aria-hidden="true"> · </span>
                      Cells capped at {integerFormatter.format(readyTable.cellCharacterLimit)} characters
                    </span>
                  </div>
                  <footer className={styles.pagination}>
                    <p>
                      Showing {integerFormatter.format(fromRow)}–{integerFormatter.format(throughRow)}
                      {readyTable.approximateRows > 0 ? ` of approximately ${integerFormatter.format(readyTable.approximateRows)}` : ""}
                    </p>
                    <div>
                      <span>Page {pageNumber}</span>
                      <button
                        type="button"
                        disabled={readyTable.offset === 0}
                        onClick={() => {
                          rowsRequestRef.current += 1;
                          setRowsState({ kind: "loading" });
                          setOffset(Math.max(0, readyTable.offset - readyTable.limit));
                        }}
                      >
                        Previous
                      </button>
                      <button
                        type="button"
                        disabled={!readyTable.hasMore}
                        onClick={() => {
                          rowsRequestRef.current += 1;
                          setRowsState({ kind: "loading" });
                          setOffset(readyTable.offset + readyTable.limit);
                        }}
                      >
                        Next
                      </button>
                    </div>
                  </footer>
                </div>
              ) : (
                <WorkspaceState
                  kind="loading"
                  title="Preparing this table"
                  description="Albert is getting the selected Fivetran table ready."
                />
              )}
            </>
          ) : (
            <WorkspaceState
              kind="empty"
              title="No tables have landed"
              description="The connected Fivetran schemas do not contain a selectable table yet."
            />
          )}
        </section>
      </div>
    </section>
  );
}
