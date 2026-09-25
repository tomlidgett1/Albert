/**
 * The recipe lane: the fast path for the head of the question distribution.
 *
 * A certified query flagged `recipe: true` in the agent config is a complete,
 * pre-validated answer plan for a recognised question shape ("sales for a
 * period", "who is rostered", "what do we owe suppliers", ...). When the intent
 * orchestrator recognises one, this lane executes it directly — the period the
 * owner named is substituted into the recipe's date parameter — and a small
 * trusted template can turn a one-row result into the final answer with no
 * model request; recipes without a valid template retain the bounded composer
 * (and its table/chart tools). No catalogue search, schema load, agentic loop,
 * or evidence review is needed on either path.
 *
 * The mechanism is connector-agnostic: recipes are declared next to the views
 * they read (any connector can ship them) and executed through the same
 * governed query path as every other query. Anything the recipe cannot answer
 * (a rejected query, an empty result, an off-shape request) hands back to the
 * regular lanes with the evidence already registered, so the fast path can
 * only save time, never lose the answer.
 */
import { Agent, user } from "@openai/agents";
import type { CertifiedQuery } from "../agent-config/loader.js";
import { ANSWER_CONTRACT, composeFromGatheredEvidence, finalAnswerSchema, laneModelSettings, renderConnectorFreshness, renderSourceFindings, todayLine, v3PromptCacheKey, withV3PromptCacheBoundary, type FinalAnswer, type LaneRunInput } from "./lanes.js";
import { createComposeTableTool, createPresentResultTool, executeGovernedCubeQuery, type CubeQueryToolInput } from "./tools.js";
import { createMakeChartTool } from "./chart-layer.js";
import { createAggregateResultTool } from "./aggregate-layer.js";
import { renderBusinessContextForClassifier } from "../context-layer/render.js";
import type { V3TurnContext } from "./context.js";
import { sanitizeTraceText } from "../../../shared/src/index.js";

import {
  extractRecipeDateRange,
  normaliseRecipeDateRange,
  recipeCubeQuery,
  recipePeriodLabel,
  renderDeterministicRecipeAnswer,
} from "../recipes/runtime.js";

export {
  extractRecipeDateRange,
  normaliseRecipeDateRange,
  recipeCubeQuery,
  recipePeriodLabel,
  renderDeterministicRecipeAnswer,
  renderDeterministicRecipeEmptyAnswer,
} from "../recipes/runtime.js";

/** Converts a certified query (Cube JSON) into the governed tool input shape. */
export function recipeToolInput(
  recipe: CertifiedQuery,
  dateRange: string | undefined,
  entity?: string | null,
): CubeQueryToolInput {
  const { topic, query } = recipeCubeQuery(recipe, dateRange, entity);
  const order = Object.entries(query.order ?? {}).map(([member, direction]) => ({ member, direction }));
  return {
    topic,
    ...(query.measures?.length ? { measures: [...query.measures] } : {}),
    ...(query.dimensions?.length ? { dimensions: [...query.dimensions] } : {}),
    ...(query.segments?.length ? { segments: [...query.segments] } : {}),
    ...(query.timeDimensions?.length ? {
      timeDimensions: query.timeDimensions as NonNullable<CubeQueryToolInput["timeDimensions"]>,
    } : {}),
    ...(query.filters?.length ? {
      filters: query.filters as NonNullable<CubeQueryToolInput["filters"]>,
    } : {}),
    ...(order.length ? { order } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
  };
}

const PRESENTATION_GUIDANCE: Record<NonNullable<CertifiedQuery["recipe"]>["presentation"], string> = {
  fact: "This is a single-figure answer: one or two sentences, no table, no chart.",
  list: "This is a list (people, documents, dates): present_result with the rows (relabel columns plainly), then one sentence. Never a chart.",
  table: "Show the table with present_result (the owner's asked-for top-N rows, plain column labels), lead with the top row in one sentence, then at most one further observation.",
  line: "Attach a line chart with make_chart (chartType auto, x = the time bucket, y = the main measure; extraYKeys for a second measure the owner would want) and write one or two sentences on the trend. Do not also compose a table unless the owner asked for one.",
  bar: "Attach a bar chart with make_chart (chartType bar, sort=y_desc, limit to the N the owner asked for or 10) and write one sentence naming the leader. Compose a table only if the owner asked for shares or a table.",
};

export async function runRecipeLane(
  input: LaneRunInput,
  recipe: CertifiedQuery,
  dateRange: string | undefined,
  entity: string | null | undefined,
): Promise<FinalAnswer | undefined> {
  const context = input.context;
  const spec = recipe.recipe;
  if (!spec) return undefined;
  await context.emit({
    type: "progress",
    status: "running",
    stage: "query",
    label: sanitizeTraceText(`Recognised question · ${recipe.name.replace(/^recipe-/u, "").replace(/-/gu, " ")}`, 160),
    detail: dateRange ? sanitizeTraceText(`Period: ${dateRange}`, 120) : undefined,
    progress: 0.2,
  });
  let result: Record<string, unknown>;
  try {
    result = await executeGovernedCubeQuery(context, recipeToolInput(recipe, dateRange, entity));
  } catch {
    return undefined;
  }
  if (result.ok !== true) return undefined;
  const rowCount = typeof result.rowCount === "number" ? result.rowCount : 0;
  // An empty period is a lead for the regular lanes (they own the diagnostics)
  // — unless the recipe declares that zero rows IS the answer (no open
  // shifts, nobody on leave): then the 80-second "why is this empty"
  // investigation would only manufacture doubt about a true negative.
  const emptyIsAnswer = rowCount === 0 && Boolean(spec.emptyAnswer);
  if (rowCount === 0 && !emptyIsAnswer) return undefined;
  if (emptyIsAnswer) context.emptyResultIsAnswer = true;

  const table = [...context.tableResults.values()].find((t) => t.resultId === result.resultId);
  if (!table) return undefined;
  const periodLabel = recipePeriodLabel(
    String(recipeCubeQuery(recipe, dateRange, entity).query.timeDimensions?.[0]?.dateRange ?? ""),
  );
  const deterministicAnswer = !emptyIsAnswer
    ? renderDeterministicRecipeAnswer(recipe, table, {
      currency: input.config.currency,
      timezone: input.config.timezone,
      ...(periodLabel ? { periodLabel } : {}),
    })
    : undefined;
  if (deterministicAnswer) {
    if ((spec.presentation === "list" || spec.presentation === "table") && table.rowCount > 0) {
      context.tableResults.set(table.resultId, { ...table, presentation: "answer" });
    }
    return {
      ...deterministicAnswer,
      followUps: [...deterministicAnswer.followUps],
      assumptionsDisclosed: [...deterministicAnswer.assumptionsDisclosed],
    };
  }
  const emptyGuidance = emptyIsAnswer
    ? `The result has NO rows, and for this question that is the answer: ${spec.emptyAnswer}. State it plainly for the period asked (one or two sentences), no table, no chart, no speculation about missing data or sync gaps.`
    : "";
  const composer = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 recipe composer",
    instructions: `${context.businessContext ? `${renderBusinessContextForClassifier(context.businessContext.document)}

` : ""}You are Albert. The owner asked a recognised question and the figures are already retrieved.
Compose the answer from the result below. Do not run data queries (you have none).

${todayLine(input.config.timezone)}

${emptyIsAnswer ? emptyGuidance : PRESENTATION_GUIDANCE[spec.presentation]}
${spec.answerHint && !emptyIsAnswer ? `Guidance for this question: ${spec.answerHint}` : ""}
The result's period is what was asked for; say it in the answer in plain words (e.g. "yesterday (Monday 17 August)", "July"). Numbers must come from the result cells; percentages and differences only via compose_table calculations.
state=Verified. followUps: zero to three short owner-voice questions; use [] for a self-contained answer.

${ANSWER_CONTRACT}

${renderSourceFindings(context.sourceFindings)}

${renderConnectorFreshness(context.connectorFreshness)}

# The result (resultId ${table.resultId}; use these exact column keys and zero-based row indexes)
${JSON.stringify({ caption: table.caption, columns: table.columns, rowCount: table.rowCount, rows: table.rows.slice(0, 60) })}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({
        partition: context.promptCachePartition,
        profile: "recipe-composer",
        route: context.toolRoute,
      }),
    }),
    tools: [createPresentResultTool(), createComposeTableTool(), createMakeChartTool(), createAggregateResultTool()],
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(composer, withV3PromptCacheBoundary(input.preferences.model, [
      user(`Question: ${sanitizeTraceText(input.intent.resolvedQuestion, 600)}`),
    ]), {
      context,
      maxTurns: 6,
      signal: input.signal ?? context.signal,
    });
    // The evidence is in; if the composer ran out of turns, compose plainly
    // from it rather than re-running the pipeline.
    const answer = run.finalOutput ?? await composeFromGatheredEvidence(input);
    // A declared empty answer is a verified true negative, not "no data".
    if (answer && emptyIsAnswer && answer.state !== "Verified") return { ...answer, state: "Verified" };
    return answer;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return composeFromGatheredEvidence(input);
    throw error;
  }
}
