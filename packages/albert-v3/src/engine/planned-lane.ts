/**
 * The planned lane: research step → parallel execution → composition.
 *
 * The agentic lanes discover the schema and the answer in the same loop: search
 * the catalogue (one model turn), load a schema (another), run a query, look at
 * it, run another… Every step is a full reasoning round-trip over a 10 KB
 * prompt, and steps are sequential, so an eight-query investigation is eight
 * serial Cube calls plus a dozen model turns.
 *
 * This lane separates the two concerns the way a good analyst (or Omni's
 * planning step) does. Retrieval is deterministic: the lexical catalogue search
 * picks candidate views and their full schemas — plus certified example queries
 * for those views — are put in front of a single planning call. The planner
 * writes the complete set of governed queries the answer needs, with exact
 * member names, in one shot. The engine validates and executes them in
 * parallel, repairs the ones the semantic layer rejected in one bounded retry,
 * and a composer turns the evidence into the answer (chart/table included).
 * Three model calls instead of ten; one wall-clock query instead of eight.
 *
 * Connector-agnostic: it reads the same catalogue and executes through the same
 * governed path as every other lane; adding a connector adds views and example
 * queries, not lane code. Anything it cannot finish (rejected plan, insufficient
 * evidence) hands back to the agentic lane with the evidence already gathered.
 */
import { Agent, system, user } from "@openai/agents";
import { z } from "zod";
import { sanitizeTraceText } from "../../../shared/src/index.js";
import { hydrateViewSchemas, searchSemanticCatalogue, type SemanticCatalogueViewSchema } from "../cube/catalogue.js";
import { matchCertifiedQueries } from "../agent-config/loader.js";
import type { V3TurnContext } from "./context.js";
import {
  ANSWER_CONTRACT,
  SURPRISE_RESOLUTION_DOCTRINE,
  buildKnowledgeBlock,
  finalAnswerSchema,
  laneModelSettings,
  renderConnectorFreshness,
  renderRequestContext,
  renderSourceFindings,
  todayLine,
  v3PromptCacheKey,
  withV3PromptCacheBoundary,
  type FinalAnswer,
  type LaneRunInput,
} from "./lanes.js";
import { createComposeTableTool, createPresentResultTool, cubeQueryInputSchema, executeGovernedCubeQuery, type CubeQueryToolInput } from "./tools.js";
import { createMakeChartTool } from "./chart-layer.js";
import { createAggregateResultTool } from "./aggregate-layer.js";
import { renderPriorResultsForPrompt } from "./prior-results.js";

/**
 * A step whose filter or date window is a value only an earlier step produces
 * ("the biggest day", "the top customer", "the leading product"). The engine
 * runs the source step first and substitutes the value — the planner never
 * guesses it. Generic over any view: it binds a result column to a filter or a
 * time dimension of another query.
 */
export const stepBindingSchema = z.object({
  fromStep: z.number().int().min(0).max(5),
  /** Exact result column key of the source step (view.dimension, or view.time_dimension.day for a date bucket). */
  fromColumn: z.string().min(1).max(160),
  /** first = the top row after the source step's order (needs an order + limit); all = every distinct value (≤ 20). */
  pick: z.enum(["first", "all"]),
  /** dateRange = bind a date value to this step's time dimension (targetMember); filter = equals on targetMember. */
  targetKind: z.enum(["dateRange", "filter"]),
  targetMember: z.string().min(1).max(160),
});

export type StepBinding = z.infer<typeof stepBindingSchema>;

const plannedStepSchema = cubeQueryInputSchema.extend({
  /** null for an independent query. */
  bind: stepBindingSchema.nullable(),
}).strict();

export type PlannedStep = z.infer<typeof plannedStepSchema>;

export const queryPlanSchema = z.object({
  /** One or two owner-readable sentences: what will be checked and why (shown as commentary). */
  plan: z.string().min(1).max(500),
  /** The governed queries, each within one view, exact members only. */
  steps: z.array(plannedStepSchema).min(1).max(6),
  presentation: z.object({
    shape: z.enum(["fact", "list", "table", "trend", "comparison", "breakdown", "diagnosis"]),
    /** Which step (0-based) a chart should plot, and how; null when no chart fits. */
    chart: z.object({
      stepIndex: z.number().int().min(0).max(5),
      chartType: z.enum(["bar", "line", "auto"]),
      xKey: z.string().min(1).max(120),
      yKey: z.string().min(1).max(120),
      seriesKey: z.string().min(1).max(120).nullable(),
    }).nullable(),
    /** Whether an owner-facing table should be composed. */
    table: z.boolean(),
  }),
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

const CANDIDATE_VIEWS = 8;
const HYDRATED_VIEWS = 3;
const MAX_HYDRATED_VIEWS = 4;
const MAX_MEMBER_LINES_PER_VIEW = 140;

function renderSchemaForPlanner(view: SemanticCatalogueViewSchema): string {
  const lines: string[] = [`## ${view.name} [${view.connector}] — ${view.title}`];
  if (view.guidance) lines.push(view.guidance.replace(/\s+/gu, " ").slice(0, 700));
  if (view.aiContext) lines.push(`Notes: ${view.aiContext.replace(/\s+/gu, " ").slice(0, 700)}`);
  if (view.queryPolicy === "aggregate_only") lines.push("Aggregate-only view: at least one measure; time members only as timeDimensions with a granularity.");
  const byFolder = new Map<string, SemanticCatalogueViewSchema["members"]>();
  for (const member of view.members) {
    const folder = member.folder ?? "Members";
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    (byFolder.get(folder) as SemanticCatalogueViewSchema["members"][number][]).push(member);
  }
  let count = 0;
  for (const [folder, members] of byFolder) {
    lines.push(`### ${folder}`);
    for (const member of members) {
      if (count >= MAX_MEMBER_LINES_PER_VIEW) break;
      const short = member.name.split(".")[1] ?? member.name;
      const description = (member.aiContext ?? member.description ?? "").replace(/\s+/gu, " ").slice(0, 110);
      lines.push(`- ${short} (${member.kind}${member.type ? `, ${member.type}` : ""})${description ? `: ${description}` : ""}`);
      count += 1;
    }
  }
  if (view.members.length > count) lines.push(`… ${view.members.length - count} more members not listed (call names as viewName.member).`);
  return lines.join("\n");
}

async function retrieveSchemas(input: LaneRunInput): Promise<{ schemas: string; viewNames: string[] }> {
  const matches = searchSemanticCatalogue(
    input.catalogue,
    input.intent.resolvedQuestion,
    input.config.accessibleViews,
    {
      allowedConnectors: input.context.toolRoute.activeCubeConnectors,
      preferredConnectors: input.context.toolRoute.preferredCubeConnectors,
      limit: CANDIDATE_VIEWS,
      memberLimit: 4,
    },
  );
  const viewNames = matches.slice(0, HYDRATED_VIEWS).map((match) => match.name);
  // A cross-tool question needs a view from each tool it touches. If the top
  // matches all come from one connector, add the best-scoring view of any other
  // connector that still scored respectably.
  const topScore = matches[0]?.score ?? 0;
  const represented = new Set(matches.slice(0, HYDRATED_VIEWS).map((match) => match.connector));
  for (const match of matches.slice(HYDRATED_VIEWS)) {
    if (viewNames.length >= MAX_HYDRATED_VIEWS) break;
    if (represented.has(match.connector)) continue;
    if (match.score < topScore * 0.35) continue;
    viewNames.push(match.name);
    represented.add(match.connector);
  }
  if (viewNames.length === 0) return { schemas: "", viewNames: [] };
  const hydrated = hydrateViewSchemas(input.catalogue, viewNames, input.config.accessibleViews);
  return { schemas: hydrated.views.map(renderSchemaForPlanner).join("\n\n"), viewNames };
}

const PLANNER_INSTRUCTIONS = `You are Albert's query planner. Given a business question and the schemas of the
most relevant governed views, write the complete, minimal set of queries that answers it — the way a
senior analyst plans before touching the data. You do not see results; you plan once, precisely.

Rules for the plan:
- Every query stays within ONE view and uses only members that appear in the schemas below (as
  view.member). If the right view is not among the schemas, choose the closest listed one — a rejected
  query costs a repair round, an invented member costs the answer.
- Prefer one query with a dimension or a granularity over many filtered queries: "sales by weekday"
  is one query per day only if the view has no weekday member — otherwise group. Period comparisons
  use compareDateRange (two or more "YYYY-MM-DD,YYYY-MM-DD" ranges) in ONE query, not two queries.
- "How is X going / how did X go" is a comparison: ONE query with compareDateRange (the current
  period and the previous comparable one) over X's core measures (volume, value, and one quality
  measure), never a single period.
- Cover every point a useful answer must cover (see request context) — usually 1–3 queries; up to 6
  for a genuine multi-angle question. Cross-tool questions take one query per tool.
- dateRange: a simple relative expression (today, yesterday, last week, last month, this quarter,
  this year, last 12 weeks, last 30 days), a named month ("July", "July 2025"), or an explicit
  "YYYY-MM-DD,YYYY-MM-DD" pair. Australian financial year runs 1 July–30 June — write FY windows as
  explicit pairs. Never a free-form phrase.
- Names the owner used (a product, category, brand, person, supplier) are colloquial: filter with
  contains on the shortest distinctive word, never equals on their wording. Several named entities
  (the five customers, these three suppliers) are ONE query with the name dimension in the output
  and one filter listing all of them (equals with several values when the names came from an
  earlier result and are exact) — never one query per entity. Status/type/enum filters:
  prefer no filter plus the dimension in the output over guessing stored values.
- Ranking questions: order by the measure desc with a limit (top N asked, else 10). Time trends:
  granularity month/week/day with a sensible window. Single figures: no dimensions.
- Buckets the view lacks (day of the week, hour of the day, day of the month): plan ONE query at
  the finest useful grain over the whole window (granularity day for weekdays, hour for time of
  day or for "Saturdays by hour"; limit 2000) — the composer re-aggregates it deterministically
  with aggregate_result (which can also keep only Saturdays / only mornings before grouping).
  Never one query per weekday, and never a filter that tries to express "every Saturday".
- Results already retrieved in earlier turns (listed in the request context) do not need a query
  unless the owner asked for a different period, granularity, measure or dimension.
- Dependent steps: when a query needs a value only an earlier step produces (the biggest day, the
  top customer, the leading product, the busiest store), never guess it — give that step a bind:
  {fromStep, fromColumn (the exact result column key of the source step, e.g. view.customer_name,
  or view.completed_at.day for a daily bucket), pick: "first" (the top row — the source step must
  order desc with a limit) or "all" (every distinct value, ≤ 20), targetKind: "dateRange" (the
  bound date becomes this step's window on targetMember, a time dimension) or "filter" (equals on
  targetMember)}. Independent steps run in parallel; a bound step runs after its source. bind is
  null for independent steps.
- presentation: shape of the useful answer; chart only for a trend (line, x = time bucket) or a
  ranking/comparison of several values (bar); never for a list of people/documents or a single figure.
  When the owner explicitly asked for a chart, plan one. seriesKey splits one measure by a dimension.
- plan: one or two plain sentences for the owner about what you will check (no jargon).`;

const COMPOSER_INSTRUCTIONS = `You are Albert. The queries planned for this question have run; their results are below.
Compose the owner-facing answer from those results only. Do not invent numbers.
- Charts: use make_chart on the result the plan nominated (or the best trend/ranking result) when
  the presentation says so or the owner asked for a chart. Tables: present_result (the rows of one result —
  pick/relabel columns, sort, top N; the usual case) or compose_table (combining results or adding
  calculated columns) for the owner-facing table when the answer is genuinely tabular (rankings,
  rosters, breakdowns, comparisons) or the owner asked for one; never a Markdown pipe table.
- Re-aggregation: when a step was planned at a fine grain to answer a weekday / hour-of-day /
  day-of-month question, call aggregate_result on that result first (groupPart weekday|hour|
  day_of_month, sum of the measures; filterPart/filterValues to keep only Saturdays or only
  morning hours), then present the derived table and chart it with
  make_chart as a bar chart (weekday / hour breakdowns are comparisons of several values —
  the plan's chart nomination applies to the derived result). One aggregate is usually
  enough: sum the headline measure (add a count column only if the owner asked for
  averages per occurrence).
- Empty results: an execution note may explain where the data actually falls (an empty-window
  diagnostic). Use it to answer with where the data sits, never to call the data broken. Money owed
  stays owed: anything unpaid before the asked window is still due.
- If the evidence genuinely cannot answer the question — the planned queries missed a needed facet,
  or every result is empty with no explanation — return state=Escalate with a one-line answer naming
  what is missing; a deeper pass will continue with this evidence.
- Otherwise state=Verified when every figure comes straight from results, Exploratory when you added
  derived calculations or interpretation.`;

const CUBE_TIMEOUT = /did not finish|timed out|Cubecore is down/iu;

function collectPlanErrors(results: ReadonlyArray<Record<string, unknown>>, steps: readonly PlannedStep[]): Array<{ index: number; step: PlannedStep; error: string }> {
  const errors: Array<{ index: number; step: PlannedStep; error: string }> = [];
  results.forEach((result, index) => {
    if (result.ok === true) return;
    const message = typeof result.error === "string" ? result.error : "The query failed.";
    // Budget exhaustion and source timeouts are not plan errors; re-planning cannot fix them.
    if (/query budget/iu.test(message) || CUBE_TIMEOUT.test(message) || /could not be bound|returned no value in column/iu.test(message)) return;
    errors.push({ index, step: steps[index]!, error: message });
  });
  return errors;
}

/** Parallel, but bounded: the semantic layer's per-turn pool is small and slow queries stall it. */
const PLAN_PARALLELISM = 3;

function stripBinding(step: PlannedStep): CubeQueryToolInput {
  const { bind: _bind, ...query } = step;
  // Fine-grained time series planned for re-aggregation must not be cut by the
  // default row limit: an hourly or daily series over a window is small in
  // bytes but long in rows.
  const fine = (query.timeDimensions ?? []).some((td) => td.granularity === "hour" || td.granularity === "day");
  if (fine && query.limit == null) {
    return { ...query, limit: 2_000 };
  }
  return query;
}

/**
 * Substitute a source step's value(s) into a bound step. Returns the concrete
 * query, or an error string when the source produced nothing usable.
 */
export function bindStep(
  step: PlannedStep,
  sourceResult: Record<string, unknown> | undefined,
  sourceRows: ReadonlyArray<Record<string, string | number | null>> | undefined,
): { query: CubeQueryToolInput } | { error: string } {
  const bind = step.bind;
  const query = stripBinding(step);
  if (!bind) return { query };
  if (!sourceResult || sourceResult.ok !== true) return { error: `Source step ${bind.fromStep} did not succeed, so this step's value could not be bound.` };
  const values: string[] = [];
  for (const row of sourceRows ?? []) {
    const raw = row[bind.fromColumn];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = String(raw);
    if (!values.includes(value)) values.push(value);
    if (bind.pick === "first" || values.length >= 20) break;
  }
  if (values.length === 0) return { error: `Source step ${bind.fromStep} returned no value in column ${bind.fromColumn}.` };
  if (bind.targetKind === "dateRange") {
    const day = values[0]!.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return { error: `Bound value "${values[0]}" is not a date.` };
    const dateRange = `${day},${day}`;
    const timeDimensions = [...(query.timeDimensions ?? [])];
    const existing = timeDimensions.findIndex((td) => td.dimension === bind.targetMember);
    if (existing >= 0) timeDimensions[existing] = { ...timeDimensions[existing]!, dateRange, compareDateRange: undefined };
    else timeDimensions.push({ dimension: bind.targetMember, dateRange });
    return { query: { ...query, timeDimensions, topic: `${query.topic} (${day})`.slice(0, 160) } };
  }
  const filters = [...(query.filters ?? []).filter((f) => f.member !== bind.targetMember), { member: bind.targetMember, operator: "equals" as const, values }];
  return { query: { ...query, filters, topic: `${query.topic} (${values.slice(0, 3).join(", ")})`.slice(0, 160) } };
}

async function executePlan(context: V3TurnContext, steps: readonly PlannedStep[]): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = new Array(steps.length);
  const runOne = async (index: number, query: CubeQueryToolInput) => {
    try {
      results[index] = await executeGovernedCubeQuery(context, query);
    } catch (error) {
      results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  // Independent steps first, in parallel (bounded); bound steps afterwards,
  // each substituting its source's value. A bind that points at another bound
  // step waits for it (one level is the common case; deeper chains resolve in order).
  const isBound = (step: PlannedStep, index: number) => Boolean(step.bind) && step.bind!.fromStep !== index && steps[step.bind!.fromStep] !== undefined;
  const independent = steps.map((step, index) => ({ step, index })).filter(({ step, index }) => !isBound(step, index));
  const dependent = steps.map((step, index) => ({ step, index })).filter(({ step, index }) => isBound(step, index));
  let next = 0;
  const workers = Array.from({ length: Math.min(PLAN_PARALLELISM, Math.max(1, independent.length)) }, async () => {
    while (next < independent.length) {
      const { step, index } = independent[next]!;
      next += 1;
      await runOne(index, stripBinding(step));
    }
  });
  await Promise.all(workers);
  for (const { step, index } of dependent) {
    const source = results[step.bind!.fromStep];
    if (source === undefined && step.bind!.fromStep !== index) {
      // Source is itself dependent and not yet run: run it first (single level of recursion).
      const sourceEntry = dependent.find((entry) => entry.index === step.bind!.fromStep);
      if (sourceEntry && results[sourceEntry.index] === undefined) {
        const bound = bindStep(sourceEntry.step, results[sourceEntry.step.bind!.fromStep], rowsFor(context, results[sourceEntry.step.bind!.fromStep]));
        if ("error" in bound) results[sourceEntry.index] = { ok: false, error: bound.error };
        else await runOne(sourceEntry.index, bound.query);
      }
    }
    if (results[index] !== undefined) continue;
    const bound = bindStep(step, results[step.bind!.fromStep], rowsFor(context, results[step.bind!.fromStep]));
    if ("error" in bound) results[index] = { ok: false, error: bound.error };
    else await runOne(index, bound.query);
  }
  return results;
}

function rowsFor(context: V3TurnContext, result: Record<string, unknown> | undefined): ReadonlyArray<Record<string, string | number | null>> | undefined {
  if (!result || result.ok !== true) return undefined;
  const stored = context.tableResults.get(String(result.resultId));
  return stored?.rows;
}

export async function runPlannedLane(
  input: LaneRunInput,
  options: Readonly<{ mode: "quick" | "analytical" }>,
): Promise<FinalAnswer | undefined> {
  const context = input.context;
  const budgetEffort = options.mode === "quick" ? input.config.lanes.quick.reasoningEffort : input.config.lanes.analytical.reasoningEffort;
  const retrieved = await retrieveSchemas(input);
  if (!retrieved.schemas) return undefined;
  const certified = matchCertifiedQueries(input.intent.resolvedQuestion, input.config, 4, context.toolRoute.activeCubeConnectors)
    .filter((query) => !query.recipe || retrieved.viewNames.some((view) => JSON.stringify(query.query).includes(`"${view}.`)));
  const examples = certified.length > 0
    ? `# Example queries on these views (trusted; adapt dates and dimensions)\n${certified.slice(0, 4).map((query) => `## ${query.name}\nAnswers: ${query.userRequest.replace(/\s+/gu, " ").trim()}\n${JSON.stringify(query.query)}`).join("\n\n")}`
    : "";
  const knowledge = buildKnowledgeBlock({ config: input.config, catalogue: input.catalogue, route: context.toolRoute, businessContext: context.businessContext?.rendered });
  const requestContext = renderRequestContext({
    config: input.config,
    question: input.intent.resolvedQuestion,
    priorResults: [...(context.priorResults?.values() ?? [])],
    assumptions: input.intent.assumptions,
    ownerGoal: input.intent.ownerGoal,
    answerMustCover: input.intent.answerMustCover,
    visiblePlan: context.visiblePlan,
    connectorFreshness: context.connectorFreshness,
    sourceFindings: context.sourceFindings,
    route: context.toolRoute,
  });

  await context.emit({
    type: "progress",
    status: "running",
    stage: "planning",
    label: "Planning the queries",
    detail: sanitizeTraceText(`Reading ${retrieved.viewNames.join(", ")}`, 300),
    progress: 0.15,
  });

  const planner = new Agent<unknown, typeof queryPlanSchema>({
    name: "Albert v3 query planner",
    instructions: `${PLANNER_INSTRUCTIONS}\n\n${knowledge}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, budgetEffort, {
      promptCacheKey: v3PromptCacheKey({ partition: context.promptCachePartition, profile: "query-planner", route: context.toolRoute }),
    }),
    outputType: queryPlanSchema,
  });
  let plan: QueryPlan | undefined;
  try {
    const run = await input.runner.run(planner, withV3PromptCacheBoundary(input.preferences.model, [
      system(`${requestContext}\n\n# Schemas of the candidate views\n${retrieved.schemas}\n\n${examples}`),
      ...input.conversation,
    ]), { maxTurns: 2, signal: input.signal ?? context.signal });
    plan = run.finalOutput;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return undefined;
    throw error;
  }
  if (!plan) return undefined;
  if (process.env.ALBERT_V3_DEBUG_PLAN) console.error(`[planned-lane] plan: ${JSON.stringify(plan)}`);

  if (context.commentary.enabled && !context.commentary.planEmitted) {
    context.commentary.planEmitted = true;
    await context.emit({ type: "narrative", text: sanitizeTraceText(plan.plan, 420) });
  }
  await context.emit({
    type: "progress",
    status: "running",
    stage: "query",
    label: `Running ${plan.steps.length} ${plan.steps.length === 1 ? "query" : "queries in parallel"}${plan.steps.some((step) => step.bind) ? ` (${plan.steps.filter((step) => step.bind).length} dependent)` : ""}`,
    detail: sanitizeTraceText(plan.steps.map((step) => step.topic).join(" · "), 300),
    progress: 0.3,
  });

  let steps: PlannedStep[] = plan.steps.map((step) => ({ ...step }));
  let results = await executePlan(context, steps);
  const errors = collectPlanErrors(results, steps);
  if (errors.length > 0) {
    // One bounded repair: hydrate the views the failed steps named (the model
    // may have reached for a view outside the candidates) and re-plan only them.
    const failedViews = [...new Set(errors.flatMap(({ step }) => [
      ...(step.measures ?? []), ...(step.dimensions ?? []), ...(step.timeDimensions ?? []).map((td) => td.dimension), ...(step.filters ?? []).map((f) => f.member),
    ].map((member) => member.split(".")[0]!)))].slice(0, 3);
    const hydrated = hydrateViewSchemas(input.catalogue, failedViews, input.config.accessibleViews);
    const repairSchemas = hydrated.views.map(renderSchemaForPlanner).join("\n\n") || retrieved.schemas;
    const repairer = new Agent<unknown, typeof queryPlanSchema>({
      name: "Albert v3 query repairer",
      instructions: `${PLANNER_INSTRUCTIONS}\n\nYou are repairing queries the semantic layer rejected. Return ONLY the corrected versions of the failed steps (same order, same intent), with exact member names from the schemas below. Keep presentation unchanged.\n\n${knowledge}`,
      model: input.preferences.model,
      modelSettings: laneModelSettings(input.preferences, "medium", {
        maxEffort: "medium",
        promptCacheKey: v3PromptCacheKey({ partition: context.promptCachePartition, profile: "query-repairer", route: context.toolRoute }),
      }),
      outputType: queryPlanSchema,
    });
    await context.emit({ type: "progress", status: "running", stage: "query", label: `Fixing ${errors.length} rejected ${errors.length === 1 ? "query" : "queries"}`, progress: 0.45 });
    try {
      const run = await input.runner.run(repairer, withV3PromptCacheBoundary(input.preferences.model, [
        system(`${requestContext}\n\n# Schemas\n${repairSchemas}\n\n# Failed steps and errors\n${errors.map(({ index, step, error }) => `## step ${index}\n${JSON.stringify(step)}\nError: ${error}`).join("\n\n")}`),
        user("Return the corrected queries."),
      ]), { maxTurns: 2, signal: input.signal ?? context.signal });
      const repaired = run.finalOutput;
      if (repaired) {
        const fixes: PlannedStep[] = repaired.steps.slice(0, errors.length).map((fix, i) => ({ ...fix, bind: fix.bind ?? errors[i]?.step.bind ?? null }));
        const fixResults = await executePlan(context, fixes);
        fixes.forEach((fix, i) => {
          const original = errors[i];
          if (!original) return;
          steps[original.index] = fix;
          results[original.index] = fixResults[i]!;
        });
      }
    } catch (error) {
      if (!(error instanceof Error && /max turns/iu.test(error.message))) throw error;
    }
  }
  const succeeded = results.filter((r) => r.ok === true).length;
  if (succeeded === 0) {
    // Every planned query timed out at the source: say so quickly instead of
    // handing to the agentic lane, which would wait out the same timeouts again.
    if (results.every((r) => CUBE_TIMEOUT.test(String(r.error ?? "")))) {
      return {
        answer: "The data source is taking too long to respond right now, so I couldn't retrieve those figures. Try again in a minute.",
        state: "Unavailable",
        followUps: [input.intent.resolvedQuestion.slice(0, 160)],
        assumptionsDisclosed: [],
      };
    }
    return undefined;
  }

  // Composition over the evidence tables (plus prior results the plan reused).
  const sources = [...context.tableResults.values()]
    .filter((table) => table.presentation === "evidence")
    .slice(-12)
    .map((table) => ({ resultId: table.resultId, caption: table.caption, columns: table.columns, rowCount: table.rowCount, rows: table.rows.slice(0, 60) }));
  const executionNotes = results.map((result, index) => {
    const step = steps[index]!;
    if (result.ok !== true) return `- step ${index} "${step.topic}": FAILED — ${String(result.error ?? "unknown")}`;
    const parts = [`- step ${index} "${step.topic}": ${String(result.rowCount)} rows → resultId ${String(result.resultId)}`];
    if (result.emptyResultDiagnostic) parts.push(`  empty-window diagnostic: ${JSON.stringify(result.emptyResultDiagnostic).slice(0, 1_200)}`);
    if (result.freshnessWarning) parts.push(`  freshness: ${JSON.stringify(result.freshnessWarning).slice(0, 400)}`);
    return parts.join("\n");
  }).join("\n");
  const chartHint = plan.presentation.chart
    ? `The plan nominated a chart: step ${plan.presentation.chart.stepIndex} (${steps[plan.presentation.chart.stepIndex]?.topic ?? "?"}), ${plan.presentation.chart.chartType}, x=${plan.presentation.chart.xKey}, y=${plan.presentation.chart.yKey}${plan.presentation.chart.seriesKey ? `, series by ${plan.presentation.chart.seriesKey}` : ""}. Attach it with make_chart unless the result turned out unsuitable (fewer than 3 points). If that step was re-aggregated with aggregate_result, chart the aggregated result instead (x = its group_ column).`
    : "The plan did not nominate a chart; add one when the owner asked for one, or when the answer is a trend (line) or a comparison/ranking of three or more values (bar) — a weekday or hour-of-day breakdown always gets a bar chart of the aggregated result (x = its group_ column). Lists of people or documents and single figures never do.";
  const composer = new Agent<V3TurnContext, typeof finalAnswerSchema>({
    name: "Albert v3 planned composer",
    instructions: `${COMPOSER_INSTRUCTIONS}

${todayLine(input.config.timezone)}

${SURPRISE_RESOLUTION_DOCTRINE}

${ANSWER_CONTRACT}

${renderSourceFindings(context.sourceFindings)}

${renderConnectorFreshness(context.connectorFreshness)}

# Request
Question: ${input.intent.resolvedQuestion}
${input.intent.ownerGoal ? `Owner's practical goal: ${input.intent.ownerGoal}` : ""}
${input.intent.answerMustCover.length > 0 ? `A useful answer must cover:\n${input.intent.answerMustCover.map((point) => `- ${point}`).join("\n")}` : ""}
Answer shape planned: ${plan.presentation.shape}. Table planned: ${plan.presentation.table ? "yes" : "no"}. ${chartHint}

${renderPriorResultsForPrompt([...(context.priorResults?.values() ?? [])])}

# Execution notes
${executionNotes}

# Result cells available to compose_table / make_chart (zero-based row indexes)
${JSON.stringify(sources)}`,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({ partition: context.promptCachePartition, profile: "planned-composer", route: context.toolRoute }),
    }),
    tools: [createPresentResultTool(), createComposeTableTool(), createMakeChartTool(), createAggregateResultTool()],
    outputType: finalAnswerSchema,
  });
  try {
    const run = await input.runner.run(composer, withV3PromptCacheBoundary(input.preferences.model, [
      ...input.conversation,
    ]), { context, maxTurns: 6, signal: input.signal ?? context.signal });
    return run.finalOutput;
  } catch (error) {
    if (error instanceof Error && /max turns/iu.test(error.message)) return undefined;
    throw error;
  }
}
