/**
 * Albert eval grader.
 *
 * Scores every recorded turn on the response-quality rubric with an
 * independent judge (Claude Opus 5, a different model family from the one under
 * test), plus deterministic checks: golden numbers/entities present in what the
 * owner saw, chart presence/type, and re-execution on reformat turns.
 *
 * Usage:
 *   npx tsx scripts/albert-eval/grade.mts --run baseline [--concurrency 6] [--resume] [--ids a,b]
 *
 * Writes evals/albert/runs/<run>/grades.jsonl (one row per turn).
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { QUESTIONS } from "./questions.js";
import { appendJsonl, loadEnv, readJsonl, runDir, type EvalTurnRecord, type GoldenResult } from "./lib.js";

type Args = { run: string; concurrency: number; resume: boolean; ids?: Set<string> };
function parseArgs(argv: string[]): Args {
  const args: Args = { run: "adhoc", concurrency: 6, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = () => argv[++i]!;
    if (a === "--run") args.run = next();
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--resume") args.resume = true;
    else if (a === "--ids") args.ids = new Set(next().split(",").map((s) => s.trim()));
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = loadEnv();
// Judge provider: Anthropic (Opus) by default; EVAL_JUDGE_PROVIDER=openai uses the
// OpenAI Responses API (EVAL_JUDGE_MODEL, default gpt-5.6-sol — the judge is a
// separate role from the model under test). Both use strict JSON-schema output.
const JUDGE_PROVIDER = (process.env.EVAL_JUDGE_PROVIDER ?? env.EVAL_JUDGE_PROVIDER ?? "anthropic") as "anthropic" | "openai";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? env.EVAL_JUDGE_MODEL ?? (JUDGE_PROVIDER === "openai" ? "gpt-5.6-sol" : "claude-opus-5");
if (JUDGE_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY missing"); process.exit(1); }
if (JUDGE_PROVIDER === "openai" && !env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY missing"); process.exit(1); }
const client = JUDGE_PROVIDER === "anthropic" ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 4 }) : undefined;
const openai = JUDGE_PROVIDER === "openai" ? new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 4, timeout: 600_000 }) : undefined;

const dir = runDir(args.run);
const results = readJsonl<EvalTurnRecord>(path.join(dir, "results.jsonl"));
const gradesFile = path.join(dir, "grades.jsonl");
// --resume keeps graded rows; rows that ended in a grader error are re-judged (and the stale row dropped).
const existing = args.resume ? readJsonl<{ id: string; error?: string }>(gradesFile) : [];
const already = new Set(existing.filter((g) => !g.error).map((g) => g.id));
if (args.resume && existing.some((g) => g.error)) {
  fs.writeFileSync(gradesFile, existing.filter((g) => !g.error).map((g) => JSON.stringify(g)).join("\n") + (already.size ? "\n" : ""));
}
const byId = new Map(results.map((r) => [r.id, r] as const));
const questionById = new Map(QUESTIONS.map((q) => [q.id, q] as const));

export const FAILURE_TAGS = [
  "wrong_number", "unsupported_number", "wrong_period", "wrong_entity", "false_zero", "stale_data_claim",
  "hallucinated_source", "missed_facet", "over_investigated", "padded", "too_thin", "jargon", "methodology_dump",
  "no_chart_when_needed", "chart_when_not_needed", "wrong_chart_type", "table_missing", "markdown_table",
  "unnecessary_clarification", "assumption_not_stated", "ignored_prior_result", "re_ran_pipeline_for_reformat",
  "reformat_not_applied", "did_not_use_conversation_context", "unavailable_or_error", "timeout", "escalated_needlessly",
  "not_connected_not_disclosed", "format_broken",
] as const;

const gradeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["correctness", "directness", "calibrated_detail", "format_fitness", "ambiguity_handling", "overall", "pass", "failure_tags", "notes", "golden_verdict"],
  properties: {
    correctness: { type: "integer", enum: [1, 2, 3, 4, 5] },
    directness: { type: "integer", enum: [1, 2, 3, 4, 5] },
    calibrated_detail: { type: "integer", enum: [1, 2, 3, 4, 5] },
    format_fitness: { type: "integer", enum: [1, 2, 3, 4, 5] },
    ambiguity_handling: { anyOf: [{ type: "integer", enum: [1, 2, 3, 4, 5] }, { type: "null" }] },
    overall: { type: "integer", enum: [1, 2, 3, 4, 5] },
    pass: { type: "boolean" },
    failure_tags: { type: "array", items: { type: "string", enum: [...FAILURE_TAGS] } },
    golden_verdict: { type: "string", enum: ["match", "partial", "mismatch", "no_golden", "golden_unavailable"] },
    notes: { type: "string" },
  },
} as const;

// OpenAI strict mode: integer enums and anyOf-null are fine; every property must be required (already so).
const openaiStrictSchema = {
  ...gradeSchema,
  properties: {
    ...gradeSchema.properties,
    ambiguity_handling: { type: ["integer", "null"], enum: [1, 2, 3, 4, 5, null] },
  },
};

// --- deterministic checks -----------------------------------------------------

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\w.])-?\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s?(k|m|%)?/giu)) {
    const whole = m[1]!.replace(/,/g, "");
    let value = Number(`${whole}${m[2] ? `.${m[2]}` : ""}`);
    const suffix = m[3]?.toLowerCase();
    if (suffix === "k") value *= 1_000;
    if (suffix === "m") value *= 1_000_000;
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

function ownerVisibleText(record: EvalTurnRecord): string {
  const parts: string[] = [record.answerText ?? "", record.clarification ?? ""];
  for (const table of record.tables) {
    if (table.presentation !== "answer") continue;
    parts.push(table.columns.map((c) => c.label).join(" | "));
    for (const row of table.rows) parts.push(Object.values(row).map((v) => (v === null || v === undefined ? "" : String(v))).join(" | "));
  }
  return parts.join("\n");
}

function evidenceText(record: EvalTurnRecord): string {
  const parts: string[] = [];
  for (const table of record.tables) {
    if (table.presentation === "answer") continue;
    for (const row of table.rows) parts.push(Object.values(row).map((v) => (v === null || v === undefined ? "" : String(v))).join(" | "));
  }
  return parts.join("\n");
}

function numberPresent(haystack: number[], target: number, tolerancePct: number): boolean {
  const tolerance = Math.max(Math.abs(target) * (tolerancePct / 100), tolerancePct === 0 ? 0 : 0.5);
  return haystack.some((n) => Math.abs(n - target) <= tolerance
    // whole-dollar rounding in prose ("about $1,144") is acceptable within 1 unit
    || (Math.abs(target) >= 100 && Math.abs(Math.round(n) - Math.round(target)) <= 1));
}

export type GoldenCheck = { label: string; mode: string; value: unknown; found: "owner" | "evidence" | "missing" | "unavailable"; note?: string };

function checkGoldens(record: EvalTurnRecord): GoldenCheck[] {
  const owner = ownerVisibleText(record);
  const evidence = evidenceText(record);
  const ownerNumbers = numbersIn(owner);
  const evidenceNumbers = numbersIn(evidence);
  return (record.golden ?? []).map((g: GoldenResult): GoldenCheck => {
    const base = { label: g.label, mode: g.mode, value: g.value, ...(g.note ? { note: g.note } : {}) };
    if (g.value === null || g.error) return { ...base, found: "unavailable" };
    if (g.mode === "value") {
      const target = g.value as number;
      if (numberPresent(ownerNumbers, target, g.tolerancePct)) return { ...base, found: "owner" };
      if (numberPresent(evidenceNumbers, target, g.tolerancePct)) return { ...base, found: "evidence" };
      return { ...base, found: "missing" };
    }
    if (g.mode === "top_entity") {
      const entity = String(g.value).toLowerCase();
      const stem = entity.split(/[^a-z0-9]+/).filter((t) => t.length > 2)[0] ?? entity;
      const inOwner = owner.toLowerCase().includes(entity) || (stem.length >= 4 && owner.toLowerCase().includes(stem));
      const inEvidence = evidence.toLowerCase().includes(entity);
      return { ...base, found: inOwner ? "owner" : inEvidence ? "evidence" : "missing" };
    }
    if (g.mode === "entity_list") {
      const entities = (g.value as string[]).map((e) => e.toLowerCase());
      if (entities.length === 0) return { ...base, found: "owner", note: "empty set" };
      const hits = entities.filter((e) => owner.toLowerCase().includes(e) || owner.toLowerCase().includes(e.split(" ")[0]!)).length;
      return { ...base, found: hits === entities.length ? "owner" : hits > 0 ? "evidence" : "missing", note: `${hits}/${entities.length} named` };
    }
    // row_count: informational only
    return { ...base, found: "owner" };
  });
}

// --- judge prompt --------------------------------------------------------------

const SYSTEM = `You are the independent grader for an evaluation of "Albert", a conversational analytics assistant for a small business (Ashburton Cycles, a bike shop in Melbourne, Australia). You score one Albert turn at a time against a rubric. You never rewrite the answer; you only judge it. Be strict, specific and consistent. Australian financial year runs 1 July–30 June. Money is AUD.

Business/data facts you may rely on:
- Connected tools: Lightspeed Retail (POS: sales, products, customers, workshop, inventory, purchase orders), Xero through Fivetran/CubeCore (accounting: invoices/bills, bank and Xero's standard monthly accrual P&L report; balance sheet/trial balance may use a native Xero report), Deputy (rostering: staff, rosters, timesheets, leave). Nothing else is connected (no Shopify, Square, Momence, Stripe).
- Lightspeed sales data runs from April 2018 through today (data is fresh; a claim that recent sales data is stale/missing is wrong). Deputy timesheets run to about two days ago; rosters extend weeks ahead. Xero bank/invoice data lags a few days.
- Xero payroll detail (pay runs/employees) is NOT populated, but Xero's governed P&L contains posted Wages and Salaries and Superannuation expense lines. Its Net Profit already deducts them and every other posted expense exactly once. Subtracting Deputy wages from Xero Net Profit again is a serious double-count; saying Xero wages are absent is wrong. Deputy remains the source for operational hours and estimated timesheet wage cost.
- The Fivetran P&L is monthly and retention-bounded. A requested period is complete only when every expected month is present. Presenting a partial period as a full FY/comparison is wrong; explicitly naming missing months is correct calibration.
- Lightspeed workshop status fields are unreliable (every job reads as open); an answer that notices and says so is better than one that reports thousands of open jobs as fact.
- Source facts Albert is given: Lightspeed sales_analytics is canonical for sales; GST collected lives in POS sales, not Xero's invoiced GST; Xero contact-level payable snapshots net credits so differ slightly from summing bills; some old bills carry junk due dates (1954/1996).
- "Sales" by default means gross takings including GST from Lightspeed. Either GST-inclusive or ex-GST is acceptable if labelled.

Rubric (score each 1–5; 5 = excellent, 3 = acceptable with a real flaw, 1 = unusable):
1. correctness — Are the figures right? Verify against the governed golden values/entities supplied and against Albert's own evidence tables (every number in the prose must be traceable to a query result). For Xero P&L, require the requested monthly coverage and the invariant Net Profit = total income - total expenses, with wages already inside expenses. Wrong period, wrong entity, unsupported or invented numbers, or a false zero/"no data" when data exists → 1–2. A correct answer with a minor imprecision (rounding, slightly different but defensible window) → 4. Fully correct → 5. If a golden number is not present in what the owner sees but a defensible alternative definition was clearly stated (e.g. ex-GST vs inc-GST, calendar YTD vs FY YTD), do not treat it as wrong. If the turn failed/timed out or returned Unavailable when data exists → 1.
2. directness — Does it answer the question that was asked, first? 5 = the asked figure/answer leads. Burying it, answering a neighbouring question, or refusing when it could answer → low.
3. calibrated_detail — Right amount of context for a busy owner. Useful extra (a light prior-period comparison, a genuinely relevant caveat) is good. Padding is a failure: methodology paragraphs, definitions of what was excluded, source-attribution disclaimers ("this uses Lightspeed only so…"), currency-code remarks, "sales basis" sections, unrequested extra breakdowns, restating table rows in prose. Too thin (missing an obviously wanted piece) is also a failure. A one-figure question deserves one or two sentences.
4. format_fitness — Chart when a time series (line) or ranking/comparison of many categories (bar) is the clearest; table when the answer is genuinely tabular (rosters, lists, breakdowns); plain prose for a single figure or short answer. Penalise: a chart missing on a trend/ranking question that asked for or clearly warrants one; a chart on a list/roster/single figure; the wrong chart type (bar for a time series is tolerable, line for unordered categories is wrong); markdown pipe tables (Albert must compose tables via its table tool — a pipe table means it broke the contract); broken or empty presentation. If a chart was requested and the "charts" list is empty → format_fitness ≤ 2.
5. ambiguity_handling — Only for underspecified questions (tier=ambiguous, or a question that genuinely admits several readings): 5 = a crisp clarifying question with sensible options OR a sensible stated assumption answered concisely; 1 = a sprawling multi-query investigation, an unstated assumption, or a clarification for something obvious. Return null when the question was not ambiguous.
overall — holistic 1–5. pass = overall ≥ 4 AND correctness ≥ 4 AND no critical failure (unsupported numbers, failed turn, chart requested but missing on a reformat turn).

Interaction-pattern rules:
- followup / drilldown turns: the answer must build on the previous turn's context (same entity/period unless changed) and resolve references ("that person", "those bills"). Ignoring the context or re-answering the first question → correctness ≤ 2 and tag did_not_use_conversation_context.
- chart_reformat turns: the deliverable is a re-rendered chart of the same data with the requested change (type, bucket, top-N, axis flip, sort, subset). Correct = a chart is present with the requested change and the same underlying figures; running many new queries for a pure re-render is a latency/efficiency failure (tag re_ran_pipeline_for_reformat) but not a correctness failure if the result is right. No chart at all → correctness ≤ 2 and reformat_not_applied.
- meta questions (what's connected, how fresh, what date range): correct = the true connection set and concrete dates; naming unconnected tools or vague "recent" answers → low.

What the owner sees: answer_markdown, charts and answer_tables (already the client's view: latest composition per caption, at most three tables, plus chart data). evidence_tables_not_shown_to_owner are the trace behind the answer — use them to verify numbers, never to judge presentation.

Failure tags: choose every tag that applies from the allowed list; leave empty when none apply. notes: ≤ 60 words, the single most important reason for the score, concrete.

Return only the JSON object required by the schema.`;

function trimRows(rows: Array<Record<string, unknown>>, n: number) {
  return rows.slice(0, n).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.split(".").at(-1)!, typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v])));
}

function buildJudgeInput(record: EvalTurnRecord, checks: GoldenCheck[]) {
  const question = questionById.get(record.id);
  const priorTurns = record.thread
    ? results.filter((r) => r.thread === record.thread && (r.turn ?? 0) < (record.turn ?? 0)).sort((a, b) => (a.turn ?? 0) - (b.turn ?? 0))
      .map((r) => ({ question: r.question, answer: (r.answerText ?? r.clarification ?? "").slice(0, 1200), charts: r.charts.map((c) => `${c.chartType} x=${c.xKey} y=${c.yKey}${c.orientation ? ` orientation=${c.orientation}` : ""}${c.series?.length ? ` series=${c.series.join("|")}` : ""}`), tables: r.tables.filter((t) => t.presentation === "answer").map((t) => `${t.caption} (${t.rowCount} rows; ${t.columns.map((c) => c.label).join(", ")})`) }))
    : [];
  return {
    today: record.startedAt.slice(0, 10),
    turn: {
      id: record.id,
      tier: record.tier,
      scope: record.scope,
      surface: record.surface,
      pattern: record.pattern,
      expected_format: record.format ?? question?.format ?? "any",
      grader_expectations: record.expect ?? question?.expect ?? null,
      question: record.question,
      prior_turns_in_thread: priorTurns,
    },
    albert_response: {
      state: record.answerState ?? (record.failed ? "FAILED" : "none"),
      failed: record.failed ?? null,
      answer_markdown: record.answerText ?? null,
      clarification_question: record.clarification ?? null,
      clarification_options: record.clarificationOptions ?? null,
      follow_up_chips: record.followUps ?? null,
      charts: record.charts,
      // What the owner actually sees: the client renders only the tables the
      // answer event presents (latest composition per caption, at most three)
      // plus any table a chart plots. Everything else is trace evidence.
      answer_tables: ownerVisibleTables(record).map((t) => ({ caption: t.caption, columns: t.columns.map((c) => c.label), rowCount: t.rowCount, rows: trimRows(t.rows, 15) })),
      evidence_tables_not_shown_to_owner: record.tables.filter((t) => !ownerVisibleTables(record).includes(t)).map((t) => ({ caption: t.caption, columns: t.columns.map((c) => c.label), rowCount: t.rowCount, rows: trimRows(t.rows, 6) })),
      queries_run: record.queries.map((q) => ({ topic: q.topic, view: q.view, rows: q.rowCount, timeRange: q.timeRange })),
      queries_executed: record.queriesExecuted ?? record.queries.length,
      latency_seconds: Math.round(record.durationMs / 1000),
      errors: record.errors,
    },
    golden_checks: checks.map((c) => ({ label: c.label, mode: c.mode, golden_value: c.value, found_in: c.found, ...(c.note ? { note: c.note } : {}) })),
  };
}

/** Mirrors the client: presented result ids from the answer event (falls back to latest answer table per caption, max 3), plus chart data refs. */
function ownerVisibleTables(record: EvalTurnRecord): EvalTurnRecord["tables"] {
  const chartRefs = new Set(record.charts.map((c) => c.dataRef));
  let presented: Set<string>;
  if (record.presentedResultIds && record.presentedResultIds.length > 0) {
    presented = new Set(record.presentedResultIds);
  } else {
    const latest = new Map<string, string>();
    for (const t of record.tables) {
      if (t.presentation !== "answer") continue;
      const key = t.caption.trim().toLowerCase();
      latest.delete(key);
      latest.set(key, t.resultId);
    }
    presented = new Set([...latest.values()].slice(-3));
  }
  return record.tables.filter((t) => presented.has(t.resultId) || chartRefs.has(t.resultId));
}

type Grade = {
  id: string; runId: string; thread?: string; turn?: number; tier: string; scope: string; surface: string; pattern: string;
  correctness: number; directness: number; calibrated_detail: number; format_fitness: number; ambiguity_handling: number | null; overall: number; pass: boolean;
  failure_tags: string[]; golden_verdict: string; notes: string; golden_checks: GoldenCheck[]; deterministic: Record<string, unknown>; judge_model: string; judged_at: string; error?: string;
};

async function judge(record: EvalTurnRecord): Promise<Grade> {
  const checks = checkGoldens(record);
  const question = questionById.get(record.id);
  const deterministic: Record<string, unknown> = {
    chart_count: record.charts.length,
    chart_types: record.charts.map((c) => c.chartType),
    answer_table_count: ownerVisibleTables(record).length,
    has_markdown_table: /^\s*\|.*\|\s*$/m.test(record.answerText ?? "") && /\|\s*:?-{3,}/.test(record.answerText ?? ""),
    queries_executed: record.queriesExecuted ?? record.queries.length,
    reformat_requeried: record.pattern === "chart_reformat" && (record.queriesExecuted ?? record.queries.length) > 1,
    reformat_no_chart: record.pattern === "chart_reformat" && record.charts.length === 0,
    expected_format: record.format ?? question?.format ?? "any",
    golden_owner_hits: checks.filter((c) => c.found === "owner").length,
    golden_total: checks.filter((c) => c.found !== "unavailable").length,
  };
  const base = {
    id: record.id, runId: record.runId, ...(record.thread ? { thread: record.thread, turn: record.turn } : {}),
    tier: record.tier, scope: record.scope, surface: record.surface, pattern: record.pattern,
    golden_checks: checks, deterministic, judge_model: JUDGE_MODEL, judged_at: new Date().toISOString(),
  };
  const input = buildJudgeInput(record, checks);
  const callJudge = async (maxTokens: number) => {
    if (openai) {
      const response = await openai.responses.create({
        model: JUDGE_MODEL,
        store: false,
        max_output_tokens: maxTokens,
        reasoning: { effort: "medium" },
        input: [
          { role: "developer", content: SYSTEM },
          { role: "user", content: `Grade this turn.\n\n${JSON.stringify(input)}` },
        ],
        text: { format: { type: "json_schema", name: "grade", strict: true, schema: openaiStrictSchema } },
      } as never) as unknown as { output_text?: string; status?: string; incomplete_details?: { reason?: string } };
      if (response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") throw new Error("judge output truncated");
      const text = response.output_text ?? "";
      if (!text) throw new Error("judge returned no text");
      return JSON.parse(text) as Omit<Grade, keyof typeof base>;
    }
    // Streamed: the SDK refuses non-streaming requests whose max_tokens implies a >10 minute wait.
    const response = await client!.messages.stream({
      model: JUDGE_MODEL,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: gradeSchema } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Grade this turn.\n\n${JSON.stringify(input)}` }],
    } as never).finalMessage() as unknown as { content: Array<{ type: string; text?: string }>; stop_reason: string };
    if (response.stop_reason === "refusal") throw new Error("judge refused");
    if (response.stop_reason === "max_tokens") throw new Error("judge output truncated");
    const text = response.content.find((b) => b.type === "text")?.text ?? "";
    return JSON.parse(text) as Omit<Grade, keyof typeof base>;
  };
  try {
    // Thinking tokens share max_tokens with the JSON; a truncated verdict is retried with more room.
    let parsed: Omit<Grade, keyof typeof base>;
    try {
      parsed = await callJudge(12_000);
    } catch (firstError) {
      if (!/truncated|JSON/iu.test(firstError instanceof Error ? firstError.message : String(firstError))) throw firstError;
      parsed = await callJudge(24_000);
    }
    // Deterministic overrides the judge cannot see past: a reformat with no chart cannot pass.
    let pass = parsed.pass;
    const tags = new Set(parsed.failure_tags);
    if (deterministic.reformat_no_chart) { pass = false; tags.add("reformat_not_applied"); }
    if (deterministic.has_markdown_table) tags.add("markdown_table");
    if (record.failed) { pass = false; tags.add(/timeout|abort/i.test(record.failed) ? "timeout" : "unavailable_or_error"); }
    return { ...base, ...parsed, pass, failure_tags: [...tags] };
  } catch (error) {
    return {
      ...base, correctness: 1, directness: 1, calibrated_detail: 1, format_fitness: 1, ambiguity_handling: null, overall: 1, pass: false,
      failure_tags: [], golden_verdict: "no_golden", notes: "grader error", error: error instanceof Error ? error.message : String(error),
    };
  }
}

const queue = results.filter((r) => !already.has(r.id) && (!args.ids || args.ids.has(r.id)));
console.log(`[grade] run=${args.run} to grade=${queue.length} (of ${results.length}) judge=${JUDGE_MODEL}`);
let cursor = 0;
let done = 0;
async function worker(): Promise<void> {
  while (cursor < queue.length) {
    const record = queue[cursor]!;
    cursor += 1;
    const grade = await judge(record);
    appendJsonl(gradesFile, grade);
    done += 1;
    console.log(`[grade ${done}/${queue.length}] ${grade.id}: overall=${grade.overall} pass=${grade.pass} correct=${grade.correctness} tags=${grade.failure_tags.join(",")}${grade.error ? ` ERROR ${grade.error}` : ""}`);
  }
}
await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, worker));
console.log(`[grade] wrote ${done} grades → ${gradesFile}`);
