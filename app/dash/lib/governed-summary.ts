import type {
  AnswerState,
  TraceEvent,
  TraceProvenance,
  TraceTableColumn,
  TraceTimeRange,
} from "@/packages/shared/src";

/**
 * Plain reading of one turn's governed decisions: which Topics Albert chose,
 * which metrics and dimensions it asked for, which tables came back, and which
 * values those tables actually contain. Derived entirely from the trace events
 * the browser already received — it adds no interpretation of its own.
 */

export type GovernedStep = Readonly<{
  id: string;
  stage: string;
  label: string;
  detail: string;
  status: string;
}>;

export type GovernedQuerySummary = Readonly<{
  id: string;
  topic: string;
  metrics: readonly string[];
  dimensions: readonly string[];
  lens: string;
  timeRange: TraceTimeRange;
}>;

export type GovernedColumnValues = Readonly<{
  key: string;
  label: string;
  values: readonly string[];
  distinctCount: number;
}>;

export type GovernedTableSummary = Readonly<{
  id: string;
  caption: string;
  resultId: string;
  rowCount: number;
  columns: readonly TraceTableColumn[];
  /** Distinct labels per non-numeric column: the categories, workers, locations. */
  categories: readonly GovernedColumnValues[];
  provenance: TraceProvenance;
}>;

export type GovernedTurnSummary = Readonly<{
  steps: readonly GovernedStep[];
  queries: readonly GovernedQuerySummary[];
  tables: readonly GovernedTableSummary[];
  charts: readonly Readonly<{ id: string; caption: string; chartType: string; dataRef: string; xKey: string; yKey: string }>[];
  validations: readonly Readonly<{ id: string; name: string; outcome: string; detail: string }>[];
  narratives: readonly string[];
  clarification?: Readonly<{ question: string; options: readonly Readonly<{ id: string; label: string }>[] }>;
  answer?: Readonly<{
    state: AnswerState;
    text: string;
    followUps: readonly string[];
    claims: readonly Readonly<{ statement: string; assertion: string; refs: readonly Readonly<{ resultId: string; rowIndex: number; columnKey: string }>[] }>[];
    provenance: TraceProvenance;
  }>;
  errors: readonly string[];
}>;

const MAX_CATEGORY_VALUES = 24;

/** Numeric columns are measures; everything else labels a row. */
function isCategoryColumn(column: TraceTableColumn): boolean {
  return column.type === "string" || column.type === "date" || column.type === "datetime";
}

function categoriesOf(
  columns: readonly TraceTableColumn[],
  rows: readonly Readonly<Record<string, string | number | null>>[],
): GovernedColumnValues[] {
  return columns.filter(isCategoryColumn).map((column) => {
    const distinct = new Set<string>();
    for (const row of rows) {
      const cell = row[column.key];
      if (cell === null || cell === undefined) continue;
      distinct.add(String(cell));
    }
    return {
      key: column.key,
      label: column.label,
      values: [...distinct].slice(0, MAX_CATEGORY_VALUES),
      distinctCount: distinct.size,
    };
  });
}

export function summarizeGovernedTurn(events: readonly TraceEvent[]): GovernedTurnSummary {
  const ordered = [...events].sort((first, second) => first.sequence - second.sequence);
  const steps: GovernedStep[] = [];
  const queries: GovernedQuerySummary[] = [];
  const tables: GovernedTableSummary[] = [];
  const charts: GovernedTurnSummary["charts"][number][] = [];
  const validations: GovernedTurnSummary["validations"][number][] = [];
  const narratives: string[] = [];
  const errors: string[] = [];
  let clarification: GovernedTurnSummary["clarification"];
  let answer: GovernedTurnSummary["answer"];

  for (const event of ordered) {
    switch (event.type) {
      case "progress": {
        const stage = event.stage ?? "step";
        // A settling step reports the same unit of work as the one that opened it.
        const openIndex = steps.findIndex((step) => step.stage === stage && step.status === "running");
        const next: GovernedStep = {
          id: event.id,
          stage,
          label: event.label,
          detail: event.detail ?? "",
          status: event.status ?? "running",
        };
        if (openIndex >= 0 && next.status !== "running") {
          steps[openIndex] = { ...next, detail: next.detail || steps[openIndex]!.detail };
        } else {
          steps.push(next);
        }
        break;
      }
      case "query":
        queries.push({
          id: event.id,
          topic: event.topic,
          metrics: event.metrics,
          dimensions: event.dimensions,
          lens: event.lens,
          timeRange: event.timeRange,
        });
        break;
      case "table":
        tables.push({
          id: event.id,
          caption: event.caption,
          resultId: event.resultId,
          rowCount: event.rows.length,
          columns: event.columns,
          categories: categoriesOf(event.columns, event.rows),
          provenance: event.provenance,
        });
        break;
      case "chart":
        charts.push({
          id: event.id,
          caption: event.caption,
          chartType: event.chartType,
          dataRef: event.dataRef,
          xKey: event.xKey,
          yKey: event.yKey,
        });
        break;
      case "validation":
        validations.push({ id: event.id, name: event.name, outcome: event.outcome, detail: event.detail });
        break;
      case "narrative":
        narratives.push(event.text);
        break;
      case "clarification":
        clarification = { question: event.question, options: event.options };
        break;
      case "answer":
        answer = {
          state: event.state,
          text: event.text,
          followUps: event.followUps,
          claims: event.claims ?? [],
          provenance: event.provenance,
        };
        break;
      case "error":
        errors.push(event.message);
        break;
      default:
        break;
    }
  }

  return {
    steps,
    queries,
    tables,
    charts,
    validations,
    narratives,
    ...(clarification ? { clarification } : {}),
    ...(answer ? { answer } : {}),
    errors,
  };
}

/** `commerce.net_sales_ex_gst` reads as `net sales ex GST` in the inspector. */
const acronyms = new Map([
  ["gst", "GST"],
  ["pos", "POS"],
  ["sku", "SKU"],
  ["abn", "ABN"],
  ["aud", "AUD"],
  ["id", "ID"],
  ["pct", "%"],
]);

export function readableTerm(value: string): string {
  return value
    .slice(value.lastIndexOf(".") + 1)
    .split("_")
    .filter(Boolean)
    .map((word) => acronyms.get(word.toLowerCase()) ?? word)
    .join(" ");
}
