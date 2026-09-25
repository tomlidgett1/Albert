/**
 * The visualiser: a presentation-only agent that runs after an answer is
 * composed and decides which of the retrieved results deserve a chart, and in
 * what form.
 *
 * Why a separate agent. Investigating and presenting are different jobs. When
 * the branch investigators owned `make_chart`, charts were drawn mid-search on
 * whatever result was in hand (nine tangled service lines over three months,
 * item-type codes as a legend) with no view of the answer they were meant to
 * support. Omni's workbook separates the two the same way: the query decides
 * the result shape, the visualisation layer maps that shape onto x / y / colour
 * facets with a best guess the analyst can override.
 *
 * Division of labour:
 * - `result-shape.ts` profiles every governed result deterministically and
 *   proposes a default form (the best guess);
 * - this agent reads the owner's question, the finished answer and the
 *   profiles, and picks at most two charts that each support a named claim —
 *   or none, when prose and tables already carry the answer;
 * - `chart-layer.ts` validates whatever it picks and refuses misleading forms.
 */
import { Agent, system, user } from "@openai/agents";
import { sanitizeTraceText } from "../../../shared/src/index.js";
import { createMakeChartTool } from "./chart-layer.js";
import type { StoredTableResult, V3TurnContext } from "./context.js";
import { asksForChart, laneModelSettings, v3PromptCacheKey, withV3PromptCacheBoundary, type FinalAnswer, type LaneRunInput } from "./lanes.js";
import { profileResult, renderResultShape, type ResultShape } from "./result-shape.js";

export const VISUALISER_INSTRUCTIONS = `You are Albert's visualiser. The analysis is finished and the owner-facing answer is written.
Your only job is to decide whether a chart would make a claim in that answer land faster than
the prose does, and if so to attach it with make_chart. You never query, never write the answer,
never invent data. Flint draws the chart from the governed table; you only pick the claim
and the result.

# How to choose (Omni-style: shape first, then intent)
Each result below comes with a shape profile and a best-guess form. Start from the best guess and
only override it when the answer's claim needs a different view.
- Trend over time (how something moved): line, x = the time bucket, at most four series. More
  than four values of a dimension over time → stacked_bar (composition per period) or the top few
  as lines; never nine lines.
- Ranking or comparison across categories (which is biggest, who leads): horizontal ranked bars,
  sorted by value, top 10-12. Never a line over categories.
- Composition / share (what the mix is): stacked_bar. Never a pie.
- Like-for-like period comparison (this year vs last): seriesKey = the period column. A monthly
  or daily x axis is overlaid on a shared month (January under January) by trusted code; never
  plot two calendar years end to end. Use a line for the overlay trend, grouped bars for a
  category ranking. Filter with where=one period only when the claim is about a single year.
- One figure, or one row: no chart — the number in prose already wins.
- Rows that are a listing (people, documents, many text columns): a table, not a chart.
- Prefer labelled dimensions (names, categories) over code columns (item_type, ids) for axes and
  series. Blank dimension values are labelled "(not set)"; if they dominate, chart something else.
- Only chart what the answer talks about. A chart of a finding the answer does not mention is
  noise. Two charts is the maximum; often one, sometimes none.
- Prefer profit or revenue over counts when both are present and the answer is about money.

# Procedure
1. Read the answer and list the two or three claims a busy owner most needs to see.
2. For each, find the result whose shape can show it. Call make_chart with a caption that names
   the claim ("Servicing labour makes 96% margin; parts make 49%"), not the data ("Revenue by
   type"). Use where / seriesKey / sort / limit to make the chart say exactly that.
3. If a call is refused, read the reason and the shape summary it returns; fix the mapping once,
   or drop that chart. Do not retry the same call.
4. When done, reply with one line: which charts were attached (or "no chart adds anything") and why.
Reply in plain text; there is no answer to write.`;

const CHART_FORMS = new Set(["bar", "grouped_bar", "stacked_bar", "line"]);

/** True when a table is a chart's own derived data rather than a source result. */
export function isDerivedChartTable(table: StoredTableResult): boolean {
  return table.provenance.definitions.some((d) => d.metric === "albert.chart_transform");
}

/**
 * The evidence tables worth showing the visualiser: real results (not
 * chart-data derivations), profiled, most recent first, capped so the prompt
 * stays small.
 */
export function chartCandidates(context: V3TurnContext, limit = 12): readonly ResultShape[] {
  return [...context.tableResults.values()]
    .filter((table) => table.presentation === "evidence" && !isDerivedChartTable(table))
    .filter((table) => (table.allRows ?? table.rows).length >= 2)
    .map(profileResult)
    .filter((shape) => shape.grain !== "scalar" && shape.grain !== "single-row")
    .slice(-limit);
}

export type VisualiserRunInput = Readonly<{
  lane: LaneRunInput;
  answer: FinalAnswer;
  /** Charts already attached this turn (e.g. by the composer); the visualiser tops up to two. */
  maxCharts?: number;
}>;

/**
 * Runs the visualiser over the turn's evidence. Best-effort: any failure is
 * logged to the trace as a progress note and the answer ships without charts.
 */
export async function runVisualiser(input: VisualiserRunInput): Promise<void> {
  const { lane, answer } = input;
  const context = lane.context;
  const alreadyCharted = context.chartedResultIds.size;
  const maxCharts = Math.max(0, (input.maxCharts ?? 2) - alreadyCharted);
  if (maxCharts === 0) return;
  if (answer.state === "No data" || answer.state === "Unavailable" || answer.state === "Escalate") return;

  const candidates = chartCandidates(context);
  const chartable = candidates.filter((shape) => CHART_FORMS.has(shape.recommendation.form));
  if (chartable.length === 0 && !asksForChart(lane.intent.resolvedQuestion)) return;

  await context.emit({
    type: "progress",
    status: "running",
    stage: "query",
    label: "Choosing how to show it",
    detail: sanitizeTraceText(`${candidates.length} result${candidates.length === 1 ? "" : "s"} profiled; up to ${maxCharts} chart${maxCharts === 1 ? "" : "s"}`, 300),
  });

  const visualiser = new Agent<V3TurnContext>({
    name: "Albert v3 visualiser",
    instructions: `${VISUALISER_INSTRUCTIONS}\n\nAttach at most ${maxCharts} chart${maxCharts === 1 ? "" : "s"} this turn.`,
    model: lane.preferences.model,
    modelSettings: laneModelSettings(lane.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: context.promptCachePartition,
        profile: "visualiser",
        route: context.toolRoute,
      }),
    }),
    tools: [createMakeChartTool()],
  });

  const shapesBlock = candidates.map(renderResultShape).join("\n");
  try {
    const run = await lane.runner.run(
      visualiser,
      withV3PromptCacheBoundary(lane.preferences.model, [
        system(`# The owner asked\n${lane.intent.resolvedQuestion}\n\n# The answer that will be shown\n${answer.answer}\n\n# Results available to chart (shape profiles and best-guess forms)\n${shapesBlock}`),
        user("Attach the chart(s) that make the answer's main claims land, or say none is needed."),
      ]),
      { context, maxTurns: 6, signal: context.signal },
    );
    const attached = context.chartedResultIds.size - alreadyCharted;
    const summary = typeof run.finalOutput === "string" ? run.finalOutput : "";
    await context.emit({
      type: "progress",
      status: "complete",
      stage: "query",
      label: attached === 0 ? "No chart adds to the answer" : `Attached ${attached} chart${attached === 1 ? "" : "s"}`,
      detail: sanitizeTraceText(summary, 300),
    });
  } catch (error) {
    if (context.signal?.aborted) return;
    await context.emit({
      type: "progress",
      status: "warning",
      stage: "query",
      label: "Visualiser skipped",
      detail: sanitizeTraceText(error instanceof Error ? error.message : String(error), 300),
    });
  }
}
