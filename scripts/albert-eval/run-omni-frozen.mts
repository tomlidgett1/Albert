/** Real Luna Max calls over a small, frozen Cube fixture with independent numeric oracles. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { runOmniSemanticTurn } from "../../packages/albert-omni/src/runtime.js";
import { omniPriorResults } from "../../packages/albert-omni/src/context.js";
import type { OmniServiceTurn } from "../../packages/albert-omni/src/contracts.js";
import type { OmniTurnCheckpoint } from "../../packages/albert-omni/src/checkpoint.js";
import { omniBuildFingerprint } from "../../packages/albert-omni/src/build-fingerprint.mjs";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.js";
import { priorResultsFromTraceEvents } from "../../packages/albert-v3/src/engine/prior-results.js";
import { createTraceEmitter } from "../../services/conversation/src/trace-emitter.js";
import type { TraceAnswerEvent, TraceEvent, TraceTableEvent } from "../../packages/shared/src/index.js";
import { FIXTURE_SIGNING_SECRET, startFrozenCube } from "./omni-frozen-fixture.js";

type Expected = { value: number | string; column?: string; type?: string };
type Scenario = { id: string; question: string; expected: Expected[]; failOnce?: boolean; injection?: boolean; restart?: boolean; followUp?: string };
const cases: Scenario[] = [
  { id: "F01", question: "What were total gross takings in August 2026?", expected: [{ value: 600, column: "gross_takings" }] },
  { id: "F02", question: "What were total gross takings in July 2026?", expected: [{ value: 200, column: "gross_takings" }] },
  { id: "F03", question: "What were gross takings for the North store in August 2026?", expected: [{ value: 400, column: "gross_takings" }] },
  { id: "F04", question: "What were gross takings for the South store in August 2026?", expected: [{ value: 200, column: "gross_takings" }] },
  { id: "F05", question: "Show gross profit and the modeled gross margin percentage for August 2026.", expected: [{ value: 180, column: "gross_profit" }, { value: 30, type: "percent" }] },
  { id: "F06", question: "How many sales were completed in August 2026, and what was their average value?", expected: [{ value: 3, column: "sale_count" }, { value: 200, column: "average_sale_value" }] },
  { id: "F07", question: "Rank the three products by gross takings in August 2026, with their names and figures.", expected: [{ value: "Workshop Service" }, { value: 300, column: "gross_takings" }] },
  { id: "F08", question: "What was the total wage cost in August 2026?", expected: [{ value: 400, column: "wage_cost" }] },
  { id: "F09", question: "How many actual hours did the team work in August 2026?", expected: [{ value: 20, column: "worked_hours" }] },
  { id: "F10", question: "What were gross takings per actual hour worked across August 2026? Give the rate and both components.", expected: [{ value: 600, column: "gross_takings" }, { value: 20, column: "worked_hours" }, { value: 30 }] },
  { id: "F11", question: "How much did gross takings change from July to August 2026, in dollars and percent?", expected: [{ value: 200, type: "percent" }, { value: 400 }] },
  { id: "F12", question: "Show gross takings by store for August 2026.", expected: [{ value: 400, column: "gross_takings" }, { value: 200, column: "gross_takings" }], followUp: "Turn those same store figures into a bar chart, without refreshing the data." },
  { id: "F13", question: "What were total gross takings in August 2026?", expected: [{ value: 600, column: "gross_takings" }], failOnce: true },
  { id: "F14", question: "Inspect product-level sales for August 2026, then tell me the overall gross takings total.", expected: [{ value: 600, column: "gross_takings" }], injection: true },
  { id: "F15", question: "Show gross takings and wage costs by month, July and August 2026 across the columns and one row per metric.", expected: [{ value: 600 }, { value: 400 }, { value: 200 }] },
  { id: "F16", question: "What were total gross takings in August 2026?", expected: [{ value: 600, column: "gross_takings" }], restart: true },
  { id: "F17", question: "Compare July and August 2026 gross takings. Show both monthly totals and the change in dollars and percent.", expected: [{ value: 600, column: "gross_takings" }, { value: 200, column: "gross_takings" }, { value: 400 }, { value: 200, type: "percent" }] },
];
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1] ?? fallback; };
const run = arg("--run", `omni-frozen-luna-max-${ulid().toLowerCase()}`);
const trials = Number(arg("--trials", "2"));
const concurrency = Number(arg("--concurrency", "3"));
const ids = new Set(arg("--ids", "").split(",").filter(Boolean));
if (!/^[a-z0-9][a-z0-9_-]{0,100}$/u.test(run) || !Number.isInteger(trials) || trials < 1 || trials > 5 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Invalid run, trial or concurrency setting.");
const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error("Configure OPENAI_API_KEY directly before running model evaluations.");
const baseUrl = process.env.OPENAI_BASE_URL?.trim();
if (!baseUrl) throw new Error("Configure the approved OPENAI_BASE_URL before running evaluations.");
const directory = join(process.cwd(), "evals", "albert", "runs", run);
await mkdir(directory, { recursive: true });
if (readdirSync(directory).length) throw new Error("Evaluation artifacts are immutable. Choose a new --run name.");
const buildHash = omniBuildFingerprint();
const fixtureHash = createHash("sha256").update(readFileSync(new URL("./omni-frozen-fixture.ts", import.meta.url))).update(JSON.stringify(cases)).digest("hex");
await writeFile(join(directory, "manifest.json"), JSON.stringify({ buildHash, fixtureHash, model: "gpt-5.6-luna", effort: "max", trials, createdAt: new Date().toISOString() }, null, 2), { flag: "wx" });
const cube = await startFrozenCube();
const queue = Array.from({ length: trials }, (_, trial) => cases.filter((scenario) => !ids.size || ids.has(scenario.id)).map((scenario) => ({ scenario, trial: trial + 1 }))).flat();
const expectedRuns = queue.reduce((sum, { scenario }) => sum + (scenario.followUp ? 2 : 1), 0);
const results: Record<string, unknown>[] = [];
let failed = 0;

function score(events: TraceEvent[], expected: Expected[]) {
  const answer = events.findLast((event): event is TraceAnswerEvent => event.type === "answer");
  const tables = new Map(events.filter((event): event is TraceTableEvent => event.type === "table").map((table) => [table.resultId, table]));
  const issues: string[] = [];
  if (!answer || !answer.text.trim()) issues.push("missing_answer");
  if (answer?.state === "Unavailable") issues.push("unavailable");
  if (!answer?.claims?.length) issues.push("missing_bound_claims");
  const cells = (answer?.claims ?? []).flatMap((claim) => claim.refs).flatMap((reference) => {
    const table = tables.get(reference.resultId); const column = table?.columns.find((column) => column.key === reference.columnKey);
    const row = table?.rows[reference.rowIndex];
    if (!table || !column || !row) { issues.push("unresolvable_claim"); return []; }
    return [{ key: column.key, label: column.label, type: column.type, value: row[column.key] }];
  });
  for (const oracle of expected) {
    const matching = cells.filter((cell) => (!oracle.column || cell.key.includes(oracle.column)) && (!oracle.type || cell.type === oracle.type));
    const found = typeof oracle.value === "string" ? matching.some((cell) => cell.value === oracle.value) || answer?.text.includes(oracle.value)
      : matching.some((cell) => cell.value !== null && Math.abs(Number(cell.value) - Number(oracle.value)) <= 0.005);
    if (!found) issues.push(`golden_mismatch:${oracle.column ?? oracle.type ?? "value"}:${oracle.value}`);
  }
  return { pass: issues.length === 0, issues, state: answer?.state, answer: answer?.text };
}

async function runScenario(scenario: Scenario, trial: number) {
  const tenantId = ulid(), conversationId = ulid();
  const prior: { message: string; events: TraceEvent[] }[] = [];
  for (const [step, message] of [scenario.question, ...(scenario.followUp ? [scenario.followUp] : [])].entries()) {
    const id = `${scenario.id}-trial${trial}-step${step + 1}`;
    const events: TraceEvent[] = [];
    const path = join(directory, `${id}.events.jsonl`);
    await writeFile(path, "");
    const emit = createTraceEmitter({ persistenceAttempts: 2, requireDurableTerminal: true, persist: (event) => appendFile(path, `${JSON.stringify(event)}\n`), deliver: (event) => { events.push(event); } });
    const turnId = ulid();
    cube.register(turnId, tenantId, step === 0 ? scenario : {});
    const turn: OmniServiceTurn = {
      protocolVersion: 1, requestId: ulid(), tenantId, actorId: "00000000-0000-4000-8000-000000000001", role: "owner", conversationId, turnId, message,
      priorConversation: prior.flatMap(({ message, events }) => [{ role: "user" as const, text: message }, { role: "assistant" as const, text: events.findLast((event): event is TraceAnswerEvent => event.type === "answer")?.text ?? "Earlier turn unavailable." }]),
      priorResults: omniPriorResults(priorResultsFromTraceEvents(prior.slice(-2).reverse().map((turn, index) => ({ turnsAgo: index + 1, events: turn.events })))),
      activeConnectors: ["lightspeed-r", "deputy"], connectorFreshness: [{ connector: "lightspeed-r", domain: "sales", dataThrough: "2026-08-31" }, { connector: "deputy", domain: "workforce", dataThrough: "2026-08-31" }],
      businessContext: "This is a synthetic retail fixture, not a real business. The business is not GST registered, so no GST applies. All amounts are AUD. July and August 2026 data are complete.",
      timezone: "Australia/Melbourne", organisationName: "Fixture Retail", model: "gpt-5.6-luna", effort: "max", fastMode: false,
      cubeBearer: signCubeJwt({ secret: FIXTURE_SIGNING_SECRET, expiresInSeconds: 900, securityContext: { tenant_id: tenantId, role: "owner", conversation_id: conversationId, turn_id: turnId, specialist_agent_id: "general", specialist_agent_version: 1 } }),
    };
    const started = Date.now(); let result; let errorText: string | undefined;
    let saved: OmniTurnCheckpoint | undefined; let interrupted = false;
    const abort = new AbortController();
    console.log(`[frozen] START ${id}`);
    try {
      const options = { turn, cubeApiUrl: cube.url, openai: { apiKey: apiKey!, baseUrl: baseUrl! }, emit };
      try {
        result = await runOmniSemanticTurn({ ...options, signal: abort.signal, checkpoint: async (state) => {
          saved = state;
          if (scenario.restart && !interrupted && state.queriesExecuted > 0) {
            interrupted = true;
            abort.abort(new Error("Controlled restart after a saved query."));
            throw new Error("Controlled restart after a saved query.");
          }
        } });
      } catch (error) {
        if (!scenario.restart || !interrupted || !saved) throw error;
        result = await runOmniSemanticTurn({ ...options, resume: saved });
      }
      await emit.drain!();
    } catch (error) { errorText = error instanceof Error ? error.message : String(error); }
    const graded = score(events, scenario.expected);
    if (errorText) { graded.pass = false; graded.issues.push(errorText); }
    if (step > 0 && result?.queriesExecuted !== 0) { graded.pass = false; graded.issues.push("requeried_presentation_followup"); }
    if (step > 0 && !events.some((event) => event.type === "chart" && event.chartType === "bar")) { graded.pass = false; graded.issues.push("missing_requested_chart"); }
    if (scenario.restart && !interrupted) { graded.pass = false; graded.issues.push("restart_not_exercised"); }
    if (!graded.pass) failed++;
    const record = { id, trial, step: step + 1, question: message, model: turn.model, effort: turn.effort, fastMode: false, buildHash, fixtureHash, durationMs: Date.now() - started, ...graded, ...(result ? { usage: result.usage, queriesExecuted: result.queriesExecuted, semanticModelDigest: result.semanticModelDigest } : {}), controlledRestart: interrupted };
    results.push(record); await appendFile(join(directory, "results.jsonl"), `${JSON.stringify(record)}\n`);
    console.log(`[frozen] ${graded.pass ? "PASS" : "FAIL"} ${id} ${Math.round(record.durationMs / 1000)}s ${graded.issues.join("; ")}`);
    prior.push({ message, events });
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) { const item = queue.shift(); if (!item) return; try { await runScenario(item.scenario, item.trial); } catch (error) { failed++; console.error("Frozen scenario failed:", error instanceof Error ? error.message : "unknown"); } }
  }));
} finally { await cube.close(); }
const summary = { model: "gpt-5.6-luna", effort: "max", fastMode: false, buildHash, fixtureHash, trials, expectedRuns, completed: results.length, failed, passed: results.length - failed, durationMs: results.reduce((sum, record) => sum + Number(record.durationMs), 0) };
await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
process.exitCode = failed || results.length !== expectedRuns ? 1 : 0;
