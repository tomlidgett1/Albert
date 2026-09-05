import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";
import { composeAnswer, type ComposeAnswerInput } from "../../packages/albert-omni/src/answer.js";
import { deriveResult, type DeriveInput } from "../../packages/albert-omni/src/derive.js";
import { boundOmniTurnContext, completedAgentHistory, compactOmniModelHistory } from "../../packages/albert-omni/src/context.js";
import { cubeQueryFromTool, omniQueryToolSchema } from "../../packages/albert-omni/src/tool-contracts.js";
import { createTraceEmitter, TracePersistenceError } from "../../services/conversation/src/trace-emitter.js";
import { priorResultsFromTraceEvents } from "../../packages/albert-v3/src/engine/prior-results.js";
import type { PivotSourceResult } from "../../packages/albert-omni/src/pivot.js";
import type { OmniServiceTurn } from "../../packages/albert-omni/src/contracts.js";
import type { ResultSemantics, TraceEvent } from "../../packages/shared/src/index.js";
import { calculateValues } from "../../packages/albert-omni/src/calculate.js";
import { queryResultSemantics } from "../../packages/albert-omni/src/evidence.js";
import { executeFrozenQuery } from "../../scripts/albert-eval/omni-frozen-fixture.js";
import { scoreOmniRecord } from "../../scripts/albert-eval/omni-score.js";
import { formatTraceCell } from "../../app/dash/components/analytical-values.js";
import { formatDashboardCell } from "../../app/dash/components/dashboard-values.js";
import { renderAssistantMarkdown } from "../../app/dash/lib/render-assistant-markdown.js";

const semantics = (count: number, completeness: ResultSemantics["completeness"] = "complete"): ResultSemantics => ({
  version: 1, completeness, returnedRows: count, rowLimit: 500, grain: ["product_id"],
  keys: { product_id: { kind: "identifier", domain: "lightspeed:product" } },
  window: "2026-08-01/2026-08-31/Australia/Melbourne", queryDigest: "q".repeat(64), semanticVersionDigest: "s".repeat(64),
});
const makeSource = (rows: Array<{ product_id: string; amount: number }>, completeness: ResultSemantics["completeness"] = "complete"): PivotSourceResult => ({
  resultId: ulid(), topic: "Synthetic sales", columns: [{ key: "product_id", label: "Product ID", type: "string" }, { key: "amount", label: "Sales", type: "currency", currency: "AUD" }],
  rows, semantics: semantics(rows.length, completeness), provenance: { sources: [{ connector: "lightspeed", label: "Fixture", dataThrough: "2026-09-01" }], timeRange: { label: "August 2026", start: "2026-08-01", end: "2026-08-31", timezone: "Australia/Melbourne" }, definitions: [], semanticBundleHash: "fixture", identityGraph: { version: 0, hash: "fixture" } },
});
const source = makeSource([{ product_id: "sku-a", amount: 100 }]);
const answerInput: ComposeAnswerInput = { outcome: "answer", markdown: "Sales were {{sales}}.", values: [{ id: "sales", resultId: source.resultId, rowIndex: 0, columnKey: "amount", format: "auto", decimals: null }], tables: [], citedResultIds: [source.resultId], limitations: [], followUps: [] };
const answerOptions = { question: "What were sales in August?", today: "2026-09-04" };
const deriveBase: Omit<DeriveInput, "operation" | "resultId"> = { caption: "Fixture", secondResultId: null, leftKey: null, rightKey: null, joinMode: null, includeColumns: null, groupBy: null, metrics: null, expressions: null };

test("a figure must reference its exact cell; a fabricated answer cannot borrow Verified", () => {
  const bad = composeAnswer({ ...answerInput, markdown: "Sales were $999,999.", values: [] }, new Map([[source.resultId, source]]), answerOptions);
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.issues.join(" "), /Unbound figures/u);
  const good = composeAnswer(answerInput, new Map([[source.resultId, source]]), answerOptions);
  assert.ok(good.ok);
  assert.equal(good.answer.state, "Verified");
  assert.equal(good.answer.text, "Sales were $100.00.");
  assert.deepEqual(good.answer.claims[0]?.refs, [{ resultId: source.resultId, rowIndex: 0, columnKey: "amount" }]);
});

test("a coincidentally matching unbound number is still rejected", () => {
  const bad = composeAnswer({ ...answerInput, markdown: "Sales were $100.", values: [] }, new Map([[source.resultId, source]]), answerOptions);
  assert.equal(bad.ok, false);
});

test("unknown cells, unused placeholders and false no-data claims are rejected", () => {
  for (const input of [
    { ...answerInput, values: [{ ...answerInput.values[0]!, rowIndex: 8 }] },
    { ...answerInput, markdown: "The result is available." },
    { ...answerInput, outcome: "no_data" as const },
  ]) assert.equal(composeAnswer(input, new Map([[source.resultId, source]]), answerOptions).ok, false);
});

test("tables are materialized from result cells and carry real claims", () => {
  const result = composeAnswer({ ...answerInput, markdown: "Your sales:\n\n{{ranking}}", values: [], tables: [{ id: "ranking", resultId: source.resultId, columnKeys: ["product_id", "amount"], limit: 10 }] }, new Map([[source.resultId, source]]), answerOptions);
  assert.ok(result.ok);
  assert.match(result.answer.text, /\| sku-a \| \$100\.00 \|/u);
  assert.equal(result.answer.claims.length, 2);
});

test("limited and reused evidence cannot silently receive Verified", () => {
  for (const candidate of [{ ...source, semantics: semantics(1, "limited") }, { ...source, priorTurn: true }]) {
    const result = composeAnswer(answerInput, new Map([[source.resultId, candidate]]), answerOptions);
    assert.ok(result.ok);
    assert.equal(result.answer.state, "Qualified");
  }
});

test("anti-joins reject incomplete right sides, including a sold item beyond the cap", () => {
  const stock = makeSource([{ product_id: "sold-after-cutoff", amount: 1 }]);
  const sold = makeSource(Array.from({ length: 500 }, (_, index) => ({ product_id: `sku-${index}`, amount: 1 })), "limited");
  const result = deriveResult({ ...deriveBase, operation: "join", resultId: stock.resultId, secondResultId: sold.resultId, leftKey: "product_id", rightKey: "product_id", joinMode: "anti" }, new Map([[stock.resultId, stock], [sold.resultId, sold]]));
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /incomplete/u);
});

test("duplicate join keys fail in both row orders; display names cannot establish identity", () => {
  const duplicate = makeSource([{ product_id: "sku-a", amount: 20 }, { product_id: "sku-a", amount: 200 }]);
  for (const right of [duplicate, { ...duplicate, rows: [...duplicate.rows].reverse() }, { ...duplicate, semantics: { ...duplicate.semantics!, keys: {} } }]) {
    const result = deriveResult({ ...deriveBase, operation: "join", resultId: source.resultId, secondResultId: right.resultId, leftKey: "product_id", rightKey: "product_id", joinMode: "left" }, new Map([[source.resultId, source], [right.resultId, right]]));
    assert.equal(result.ok, false);
  }
});

test("a limited aggregate needs an explicit subset scope and retains its limitation", () => {
  const limited = { ...source, semantics: semantics(1, "limited") };
  const input: DeriveInput = { ...deriveBase, operation: "aggregate", resultId: source.resultId, metrics: [{ valueKey: "amount", fn: "sum", label: "Subtotal" }] };
  assert.equal(deriveResult(input, new Map([[source.resultId, limited]])).ok, false);
  const subtotal = deriveResult({ ...input, aggregateScope: "returned_rows" }, new Map([[source.resultId, limited]]));
  assert.ok(subtotal.ok);
  assert.equal(subtotal.result.rows[0]?.scope, "Selected rows only");
  assert.equal(subtotal.result.semantics.completeness, "limited");
});

const queryInput = { name: "Fixture query", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], dimensions: null, segments: null, timeDimensions: null, filters: null, order: null, limit: null } };
test("malformed and ambiguous filters fail without broadening the query", () => {
  for (const filter of [
    { member: "sales_analytics.store_name", operator: null, values: ["Store"], and: null, or: null },
    { member: null, operator: null, values: null, and: null, or: null },
    { member: "sales_analytics.store_name", operator: "equals", values: ["Store"], and: [], or: null },
  ]) assert.equal(omniQueryToolSchema.safeParse({ ...queryInput, query: { ...queryInput.query, filters: [filter] } }).success, false);
  assert.throws(() => cubeQueryFromTool({ ...queryInput, query: { ...queryInput.query, filters: [{ member: "sales_analytics.store_name", operator: "equals", values: null, and: null, or: null }] } }), /requires values/u);
});

test("context is bounded by serialized bytes, preserves the question, and leaves its input untouched", () => {
  const turn = { protocolVersion: 1, requestId: ulid(), tenantId: ulid(), actorId: "00000000-0000-4000-8000-000000000001", role: "owner", conversationId: ulid(), turnId: ulid(), message: "Keep this question", priorConversation: Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: "界".repeat(24_000) })), activeConnectors: [], connectorFreshness: [], cubeBearer: "a.b.c", model: "gpt-5.6-luna", effort: "max", fastMode: false } as OmniServiceTurn;
  const bounded = boundOmniTurnContext(turn);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 160 * 1024);
  assert.equal(bounded.message, turn.message);
  assert.equal(turn.priorConversation.length, 12);
});

test("interruption history retains complete tool pairs and removes unfinished calls", () => {
  const history = [{ type: "function_call", callId: "done", name: "one", arguments: "{}" }, { type: "function_call_result", callId: "done", name: "one", status: "completed", output: "ok" }, { type: "function_call", callId: "lost", name: "two", arguments: "{}" }] as never;
  assert.equal(completedAgentHistory(history).length, 2);
});

test("trace retries preserve sequence and deliver the terminal answer only after saving it", async () => {
  const attempts: number[] = []; const saved: number[] = []; const delivered: number[] = [];
  const emit = createTraceEmitter({ persistenceAttempts: 3, requireDurableTerminal: true, retryDelay: async () => {}, persist: async (event) => { attempts.push(event.sequence); if (attempts.length === 1) throw Error("transient"); assert.equal(event.sequence, saved.length + 1); saved.push(event.sequence); }, deliver: (event) => { if (event.type === "answer") assert.equal(saved.at(-1), event.sequence); delivered.push(event.sequence); } });
  await emit({ type: "progress", status: "running", stage: "planning", label: "Working" });
  await emit({ type: "answer", status: "complete", state: "Exploratory", text: "Fixture complete.", provenance: source.provenance, followUps: [], claims: [] });
  assert.deepEqual(attempts, [1, 1, 2]);
  assert.deepEqual(delivered, [1, 2]);
  assert.deepEqual(await emit.drain!(), { persisted: 2, failed: 0 });
});

test("a permanent trace failure blocks later writes and prevents a successful answer", async () => {
  const delivered: TraceEvent[] = []; let writes = 0;
  const emit = createTraceEmitter({ persistenceAttempts: 2, requireDurableTerminal: true, retryDelay: async () => {}, persist: async () => { writes++; throw Error("offline"); }, deliver: (event) => { delivered.push(event); } });
  await emit({ type: "progress", status: "running", stage: "planning", label: "Working" });
  await assert.rejects(emit({ type: "answer", status: "complete", state: "Verified", text: "Cannot save", provenance: source.provenance, followUps: [] }), TracePersistenceError);
  assert.equal(writes, 2);
  assert.equal(delivered.some((event) => event.type === "answer"), false);
});

test("retained prior evidence preserves the original row count and marks a shortened snapshot", () => {
  const result = priorResultsFromTraceEvents([{ turnsAgo: 1, events: [{ type: "query", resultId: source.resultId, rowCount: 500, view: "sales_analytics", queryYaml: "query" }, { type: "table", ...source, semantics: semantics(500, "limited") }] }]);
  assert.equal(result[0]?.rowCount, 500);
  assert.equal(result[0]?.semantics?.completeness, "limited");
});

test("cross-row arithmetic computes exact changes and percentages from cell references", () => {
  const source = makeSource([{ product_id: "current", amount: 600 }, { product_id: "previous", amount: 200 }]);
  const left = { resultId: source.resultId, rowIndex: 0, columnKey: "amount" };
  const right = { ...left, rowIndex: 1 };
  const result = calculateValues({ caption: "Change", calculations: [{ key: "change", label: "Change", kind: "difference", left, right }, { key: "growth", label: "Growth", kind: "percent_change", left, right }] }, new Map([[source.resultId, source]]));
  assert.ok(result.ok);
  assert.deepEqual(result.result.rows, [{ change: 400, growth: 200 }]);
});

test("decimal calculations preserve large monetary operands and qualify zero divisors", () => {
  const large = { ...source, rows: [{ product_id: "current", amount: "9007199254740992.1234" }, { product_id: "previous", amount: "9007199254740992.1000" }, { product_id: "zero", amount: 0 }] };
  const left = { resultId: source.resultId, rowIndex: 0, columnKey: "amount" };
  const result = calculateValues({ caption: "Exact arithmetic", calculations: [{ key: "difference", label: "Difference", kind: "difference", left, right: { ...left, rowIndex: 1 } }, { key: "ratio", label: "Ratio", kind: "ratio", left, right: { ...left, rowIndex: 2 } }] }, new Map([[source.resultId, large]]));
  assert.ok(result.ok);
  assert.equal(result.result.rows[0]?.difference, 0.0234);
  assert.equal(result.result.rows[0]?.ratio, null);
  assert.ok(result.result.semantics?.qualifications?.length);
});

test("canonical time columns retain a shared period key even without a bucket suffix", () => {
  const result = queryResultSemantics({ query: { measures: ["sales_analytics.gross_takings"], timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "day", dateRange: ["2026-08-01", "2026-08-31"] }], timezone: "Australia/Melbourne" }, rowCount: 3, retainedRows: 3, columns: [{ key: "sales_analytics_completed_at", label: "Date", type: "datetime" }], connector: "lightspeed", queryDigest: "q", semanticVersionDigest: "s" });
  assert.equal(result.keys.sales_analytics_completed_at?.domain, "time:Australia/Melbourne:day");
});

test("frozen numeric oracles distinguish scope and date windows", () => {
  const query = { measures: ["sales_analytics.gross_takings"], timeDimensions: [{ dimension: "sales_analytics.completed_at", dateRange: ["2026-08-01", "2026-08-31"] as const }] };
  assert.deepEqual(executeFrozenQuery(query).data, [{ "sales_analytics.gross_takings": 600 }]);
  assert.deepEqual(executeFrozenQuery({ ...query, filters: [{ member: "sales_analytics.store_name", operator: "equals", values: ["North"] }] }).data, [{ "sales_analytics.gross_takings": 400 }]);
});

test("eval gates reject missing claims and numeric goldens even if the state says Verified", () => {
  const record = { answerState: "Verified", answerText: "Sales were $100", queriesExecuted: 1, tables: [], golden: [{ label: "Sales", member: "sales.amount", mode: "value", value: 100, tolerancePct: 0, rows: [] }] } as never;
  const result = scoreOmniRecord(record);
  assert.equal(result.pass, false);
  assert.ok(result.issues.includes("verified_without_claims"));
  assert.ok(result.issues.includes("golden_mismatch:Sales"));
});

test("model context compaction preserves result IDs, columns and the full original history", () => {
  const value = JSON.stringify({ ok: true, resultId: source.resultId, columns: source.columns, rowCount: 500, rows: Array.from({ length: 500 }, () => ({ amount: 100, product_id: "a".repeat(300) })) });
  const history = [{ type: "function_call_result", name: "GenerateSemanticQuery", callId: "test", status: "completed", output: value }] as never;
  const compacted = compactOmniModelHistory(history, 10_000);
  assert.ok(Buffer.byteLength(JSON.stringify(compacted)) < 10_000);
  const body = JSON.parse(String((compacted[0] as { output: string }).output));
  assert.equal(body.resultId, source.resultId);
  assert.equal(body.truncated, true);
  assert.equal(JSON.parse((history as { output: string }[])[0]!.output).rows.length, 500);
});

test("an answer cannot substitute a different explicit month", () => {
  const july = { ...source, semantics: undefined, provenance: { ...source.provenance, timeRange: { ...source.provenance.timeRange, start: "2026-07-01", end: "2026-07-31", label: "July 2026" } } };
  const result = composeAnswer(answerInput, new Map([[source.resultId, july]]), { ...answerOptions, question: "What were sales in August 2026?" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues.join(" "), /requested period/u);
});

test("percentage points below one render consistently in chat and dashboard tables", () => {
  const column = { key: "change", label: "Change", type: "percent" as const, percentScale: "percent" as const };
  assert.equal(formatTraceCell(0.5, column), "+0.5%");
  assert.equal(formatDashboardCell(0.5, column), "+0.5%");
  assert.equal(formatTraceCell(0.5, { ...column, percentScale: "ratio" }), "+50%");
});

test("composed single-column tables and escaped source labels render as literal data", () => {
  const html = renderAssistantMarkdown("| Margin |\n| ---: |\n| 0.5% |");
  assert.match(html, /<table>/u);
  assert.match(html, /<td>0\.5%<\/td>/u);
  const labels = renderAssistantMarkdown("| Name |\n| --- |\n| A\\*B \\(retail\\) |");
  assert.match(labels, /A\*B \(retail\)/u);
  assert.doesNotMatch(labels, /<em>/u);
  assert.match(renderAssistantMarkdown("**A\\*B**"), /<strong>A\*B<\/strong>/u);
});

test("follow-up links leave the composed prose and become deduplicated chips", () => {
  const result = composeAnswer({ ...answerInput, markdown: `${answerInput.markdown}\n\n[Compare with last year?](?ai-query=Compare%20with%20last%20year)`, followUps: ["Compare with last year?"] }, new Map([[source.resultId, source]]), answerOptions);
  assert.ok(result.ok);
  assert.doesNotMatch(result.answer.text, /ai-query/u);
  assert.deepEqual(result.answer.followUps, ["Compare with last year?"]);
});
