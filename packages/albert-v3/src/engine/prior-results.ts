/**
 * Prior-turn result retention.
 *
 * A follow-up ("make it a bar chart", "top 5 only", "and the month before?")
 * used to re-run the whole pipeline because the engine started every turn with
 * an empty result registry: the previous answer's rows existed only as a
 * 12 KB prose digest. This module carries the governed result sets of the last
 * few turns into the new turn as first-class, addressable results, so the
 * presentation tools (make_chart, compose_table) and the model can operate on
 * data that is already retrieved. It is connector-agnostic: a prior result is a
 * table with columns and rows, whatever produced it.
 *
 * Materialisation is lazy: a prior result is re-emitted as a table event in the
 * current turn only when a tool actually uses it, so the trace stays small and
 * the client can render the chart against a table it has seen this turn.
 */
import type {
  TraceCell,
  TraceConnector,
  TraceProvenance,
  TraceTableColumn,
} from "../../../shared/src/index.js";
import { sanitizeTraceText } from "../../../shared/src/index.js";
import type { StoredTableResult, V3TurnContext } from "./context.js";

export type PriorTurnResult = Readonly<{
  /** The resultId the previous turn published; stable so the model can address it. */
  resultId: string;
  /** 1 = the immediately previous answer, 2 = the one before that. */
  turnsAgo: number;
  caption: string;
  presentation: "evidence" | "answer";
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  /** True row count of the original result (rows may be a bounded prefix). */
  rowCount: number;
  view?: string;
  connector?: TraceConnector;
  /** The governed query behind the result, when it was a direct query result. */
  queryYaml?: string;
  timeRangeLabel?: string;
  provenance?: TraceProvenance;
}>;

/** How many prior results, and how many rows each, the model is shown. */
export const PRIOR_RESULTS_PROMPT_LIMIT = 6;
export const PRIOR_RESULT_PROMPT_ROWS = 40;
/** Hard ceiling on the rendered block so long conversations stay cache-friendly. */
export const PRIOR_RESULTS_PROMPT_MAX_CHARS = 14_000;

function isNumericColumn(column: TraceTableColumn): boolean {
  return column.type === "number" || column.type === "currency" || column.type === "percent";
}

/**
 * Registers prior results on the turn context. They are not yet table events
 * of this turn; `resolveTableResult` materialises one on first use.
 */
export function registerPriorResults(context: V3TurnContext, prior: readonly PriorTurnResult[]): void {
  if (!context.priorResults) return;
  for (const result of prior) {
    if (context.tableResults.has(result.resultId)) continue;
    context.priorResults.set(result.resultId, result);
  }
}

function fallbackProvenance(result: PriorTurnResult, timezone: string): TraceProvenance {
  return {
    sources: [{
      connector: result.connector ?? "lightspeed",
      label: result.view ? `Earlier result · ${result.view}` : "Earlier result",
      dataThrough: "unknown",
    }],
    timeRange: {
      label: result.timeRangeLabel ?? "As previously retrieved",
      start: "unknown",
      end: "unknown",
      timezone,
    },
    definitions: [],
    semanticBundleHash: "albert-v3-prior-result",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
}

/**
 * Looks a resultId up among this turn's results first, then among prior-turn
 * results. A prior result used for the first time is re-emitted as an evidence
 * table event of this turn under the SAME resultId (so charts and composed
 * tables can reference it and the client has a table to render), and from then
 * on behaves like any other result of the turn.
 */
export async function resolveTableResult(
  context: V3TurnContext,
  resultId: string,
): Promise<StoredTableResult | undefined> {
  const current = context.tableResults.get(resultId);
  if (current) return current;
  const prior = context.priorResults?.get(resultId);
  if (!prior) return undefined;
  const provenance = prior.provenance ?? fallbackProvenance(prior, context.config.timezone);
  const caption = sanitizeTraceText(prior.caption.startsWith("Earlier result · ") ? prior.caption : `Earlier result · ${prior.caption}`, 160);
  const tableEvent = await context.emit({
    type: "table",
    status: "complete",
    caption,
    columns: prior.columns,
    rows: prior.rows,
    resultId,
    provenance,
    presentation: "evidence",
  });
  const stored: StoredTableResult = {
    tableEventId: tableEvent.id,
    resultId,
    caption: prior.caption.replace(/^Earlier result · /u, ""),
    columns: prior.columns,
    rows: prior.rows,
    columnKeys: prior.columns.map((column) => column.key),
    numericColumnKeys: prior.columns.filter(isNumericColumn).map((column) => column.key),
    rowCount: prior.rowCount,
    provenance,
    presentation: "evidence",
    reusedFromPriorTurn: true,
  };
  context.tableResults.set(resultId, stored);
  context.priorResults.delete(resultId);
  return stored;
}

function renderCell(value: TraceCell): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value).replace(/\s+/gu, " ").slice(0, 60);
}

/**
 * The block the model sees: enough to address cells (resultId, column keys,
 * zero-based row indexes) without a fresh query. Bounded on every axis.
 */
export function renderPriorResultsForPrompt(prior: readonly PriorTurnResult[]): string {
  if (prior.length === 0) return "";
  const ordered = [...prior]
    .sort((a, b) => a.turnsAgo - b.turnsAgo || (a.presentation === "answer" ? -1 : 1))
    .slice(0, PRIOR_RESULTS_PROMPT_LIMIT);
  const sections: string[] = [
    "# Results already retrieved earlier in this conversation (reusable now, no query needed)",
    "Each result below is addressable by resultId in make_chart and compose_table exactly like a result from this turn. "
    + "When the owner asks to re-present, re-chart, re-sort, re-bucket into coarser periods, filter, subset (top N, last N), or flip what is already on screen, "
    + "USE THESE DIRECTLY — do not run a new query for data that is already here. Query again only for data these results do not contain "
    + "(a different period, finer granularity, a different measure or dimension). Row indexes are zero-based.",
  ];
  let chars = sections.join("\n").length;
  for (const result of ordered) {
    const columns = result.columns.map((column) => `${column.key} (${column.label}${isNumericColumn(column) ? ", numeric" : ""})`).join("; ");
    const header = `## resultId ${result.resultId} — ${result.caption} [${result.turnsAgo === 1 ? "previous answer" : `${result.turnsAgo} answers ago`}, ${result.rowCount} row${result.rowCount === 1 ? "" : "s"}${result.timeRangeLabel ? `, ${result.timeRangeLabel}` : ""}${result.view ? `, from ${result.view}` : ""}]\ncolumns: ${columns}`;
    const rows = result.rows.slice(0, PRIOR_RESULT_PROMPT_ROWS).map((row, index) =>
      `${index}: ${result.columns.map((column) => renderCell(row[column.key] ?? null)).join(" | ")}`);
    const block = `${header}\n${rows.join("\n")}${result.rows.length > PRIOR_RESULT_PROMPT_ROWS ? `\n… ${result.rows.length - PRIOR_RESULT_PROMPT_ROWS} more rows not shown (all rows are usable by index)` : ""}`;
    if (chars + block.length > PRIOR_RESULTS_PROMPT_MAX_CHARS) break;
    chars += block.length;
    sections.push(block);
  }
  return sections.join("\n\n");
}

/**
 * Builds PriorTurnResult entries from persisted trace events of earlier turns
 * (the shape `albert_conversation_history` returns): table events carry rows,
 * query events carry the governed query. Used by the web route and the eval
 * harness alike so both feed the engine identically.
 */
export function priorResultsFromTraceEvents(
  turns: ReadonlyArray<Readonly<{ turnsAgo: number; events: readonly unknown[] }>>,
  options?: Readonly<{ maxResultsPerTurn?: number; maxRows?: number }>,
): PriorTurnResult[] {
  const maxResultsPerTurn = options?.maxResultsPerTurn ?? 4;
  const maxRows = options?.maxRows ?? 50;
  const out: PriorTurnResult[] = [];
  const seen = new Set<string>();
  for (const turn of [...turns].sort((a, b) => a.turnsAgo - b.turnsAgo)) {
    const events = turn.events.filter((event): event is Record<string, unknown> => Boolean(event) && typeof event === "object" && !Array.isArray(event));
    const queries = events.filter((event) => event.type === "query");
    const tables = events.filter((event) => event.type === "table");
    // Answer tables first (what the owner saw), then the most recent evidence tables.
    const ordered = [
      ...tables.filter((table) => table.presentation === "answer"),
      ...tables.filter((table) => table.presentation !== "answer").reverse(),
    ].slice(0, maxResultsPerTurn);
    for (const table of ordered) {
      const resultId = typeof table.resultId === "string" ? table.resultId : undefined;
      const columns = Array.isArray(table.columns) ? table.columns as TraceTableColumn[] : [];
      const rows = Array.isArray(table.rows) ? (table.rows as Readonly<Record<string, TraceCell>>[]).slice(0, maxRows) : [];
      if (!resultId || columns.length === 0 || seen.has(resultId)) continue;
      seen.add(resultId);
      // The query event that produced this table (Cube tables emit query then table with the same view).
      const provenance = table.provenance && typeof table.provenance === "object" ? table.provenance as TraceProvenance : undefined;
      const view = provenance?.view?.name;
      const query = queries.find((q) => typeof q.view === "string" && q.view === view && typeof q.queryYaml === "string");
      out.push({
        resultId,
        turnsAgo: turn.turnsAgo,
        caption: typeof table.caption === "string" ? table.caption.replace(/^(?:Earlier result · )+/u, "") : "Earlier result",
        presentation: table.presentation === "answer" ? "answer" : "evidence",
        columns,
        rows,
        rowCount: rows.length,
        ...(view ? { view } : {}),
        ...(provenance?.sources?.[0]?.connector ? { connector: provenance.sources[0].connector } : {}),
        ...(query && typeof query.queryYaml === "string" ? { queryYaml: query.queryYaml } : {}),
        ...(provenance?.timeRange?.label ? { timeRangeLabel: provenance.timeRange.label } : {}),
        ...(provenance ? { provenance } : {}),
      });
    }
  }
  return out;
}
