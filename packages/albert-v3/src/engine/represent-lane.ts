/**
 * The re-present lane: change how the previous answer is shown, using the data
 * already retrieved.
 *
 * "Make it a bar chart", "top 10 only", "flip the axes", "sort it", "show only
 * the last 6 months", "monthly totals instead" are presentation changes, not
 * questions. Routing them through the quick lane meant a 10 KB knowledge prompt,
 * a catalogue search, a fresh Cube query and a full compose pass — 20–45 s for
 * a re-render. This lane runs a small agent with only the presentation tools
 * (make_chart, compose_table) over the prior-turn results carried by
 * prior-results.ts. If the request needs data that was not retrieved, it hands
 * back (state=Escalate) and the quick lane continues with the same prior
 * results still available.
 *
 * Connector-agnostic by construction: it never touches a data source.
 */
import { Agent } from "@openai/agents";
import { ANSWER_CONTRACT, finalAnswerSchema, laneConversationInput, laneModelSettings, v3PromptCacheKey, type FinalAnswer, type LaneRunInput } from "./lanes.js";
import { createComposeTableTool, createPresentResultTool } from "./tools.js";
import { createMakeChartTool } from "./chart-layer.js";
import { createAggregateResultTool } from "./aggregate-layer.js";
import type { V3TurnContext } from "./context.js";

export const REPRESENT_LANE_INSTRUCTIONS = `You are Albert, changing how an answer that is already on screen is presented.
The owner's request is a presentation change (chart type, bar or line, orientation, sort order,
top-N or last-N subset, coarser buckets that the rows on screen already support, table instead of
chart, or the reverse). The data is already retrieved: the request context lists every earlier
result with its resultId, column keys and rows.

Procedure:
1. Pick the earlier result that holds the data the owner is looking at (normally the previous
   answer's result). Do not run any data query — you have no query tools.
2. Apply the change with ONE tool call:
   - make_chart for any chart change. Use chartType as asked (bar / stacked_bar / line); "auto" when
     the owner did not name a type. "Stacked" or "as a share / mix" means stacked_bar; "side by side"
     means bar with a seriesKey. Use sort=y_desc + limit for "top N"; limit + take=last (natural x order) for
     "the last N days/weeks/months"; seriesKey to split by a dimension; extraYKeys for several
     measures; orientation=horizontal for "dates/names on the y axis" or "flip it".
     Re-bucketing into coarser periods (weekly → monthly, daily → weekly) needs a fresh
     aggregation: return state=Escalate for it (see 4).
   - present_result for a table view (subset, re-order, fewer columns, sort, top N); compose_table only when a calculated column is needed.
3. Answer in one or two short sentences: what changed and, if the chart shows something notable,
   one observation. Do not restate the numbers, do not describe methodology, do not add caveats.
   state=Verified. followUps: zero to two short owner-voice questions; use [] when the requested presentation change is complete.
4. Only if the change genuinely needs data that is not in the earlier results (a longer or
   different period, finer granularity, a different measure or dimension, a comparison year, or
   re-bucketing that needs a fresh aggregation), return state=Escalate with a one-line answer naming
   what is needed. Never invent numbers and never write a Markdown table.

${ANSWER_CONTRACT}`;

export async function runRepresentLane(input: LaneRunInput): Promise<FinalAnswer | undefined> {
  if ((input.context.priorResults?.size ?? 0) === 0 && ![...input.context.tableResults.values()].some((t) => t.reusedFromPriorTurn)) {
    return undefined;
  }
  const agent = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 re-present lane",
    instructions: REPRESENT_LANE_INSTRUCTIONS,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: input.context.promptCachePartition,
        profile: "represent-lane",
        route: input.context.toolRoute,
      }),
    }),
    tools: [createMakeChartTool(), createPresentResultTool(), createComposeTableTool(), createAggregateResultTool()],
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(agent, laneConversationInput(input), {
      context: input.context,
      maxTurns: 5,
      signal: input.signal ?? input.context.signal,
    });
    return run.finalOutput;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return undefined;
    throw error;
  }
}
