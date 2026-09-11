import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ulid } from "ulid";
import { composeManagedAnswer, type ManagedAnswer } from "../../packages/albert-agents-api/src/answer.js";
import { ResultReferences } from "../../packages/albert-agents-api/src/references.js";
import { createGovernedToolRegistry, fillNullableArguments, NativeToolInputError } from "../../packages/albert-agents-api/src/tools.js";
import { isExpiredManagedSession } from "../../packages/albert-agents-api/src/retention.js";
import { MANAGED_SESSION_IDLE_MS, MANAGED_SESSION_NAMESPACE } from "../../packages/albert-agents-api/src/session-state.js";
import { omniQueryToolSchema } from "../../packages/albert-omni/src/tool-contracts.js";
import type { AnswerEvidence } from "../../packages/albert-omni/src/answer.js";
import type { AgentSession } from "openai/resources/beta/agents/agents";
import { renderAssistantMarkdown } from "../../app/dash/lib/render-assistant-markdown.js";
import { calculateValues } from "../../packages/albert-omni/src/calculate.js";

const id = ulid();
const evidence: AnswerEvidence = {
  resultId: id, topic: "Sales", columns: [{ key: "store", label: "Store", type: "string" }, { key: "gross", label: "Gross takings", type: "currency", currency: "AUD" }],
  rows: [{ store: "North", gross: 600 }],
  semantics: { version: 1, completeness: "complete", returnedRows: 1, rowLimit: 500, grain: ["store"], keys: {}, window: "August 2026", queryDigest: "q", semanticVersionDigest: "s" },
  provenance: { sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-08-31" }], timeRange: { label: "August 2026", start: "2026-08-01", end: "2026-08-31", timezone: "Australia/Melbourne" }, definitions: [], semanticBundleHash: "s", identityGraph: { version: 0, hash: "i" } },
};
const sources = new Map([[id, evidence]]);
const options = { question: "What were gross takings for August 2026? Show a table.", today: "2026-09-11" };
const answer: ManagedAnswer = {
  outcome: "answer", summary: "Gross takings were {{august_2026}}.", detail: "",
  values: [{ name: "august_2026", result: "r1", column: "gross", row: 0 }],
  tables: [{ title: "By store", result: "r1", columns: ["store", "gross"], limit: 10 }],
  citedResults: ["r1"], limitations: [], followUps: [],
};
const compose = (value: unknown) => composeManagedAnswer(value, sources, (alias) => alias === "r1" ? id : undefined, options);

test("native answers resolve compact handles and materialize complete tables", () => {
  const result = compose(answer);
  assert.ok(result.ok);
  assert.equal(result.answer.state, "Verified");
  assert.match(result.answer.text, /Gross takings were \$600\.00/u);
  assert.ok(result.answer.claims.length >= 2);
  const html = renderAssistantMarkdown(result.answer.text);
  assert.equal((html.match(/<tr>/gu) ?? []).length, 2);
  assert.ok(!html.includes("<td>---"));
});

test("native answer validation rejects invented money and unknown result handles", () => {
  for (const candidate of [
    { ...answer, summary: "Gross takings were $999.00.", values: [] },
    { ...answer, summary: "Revenue was $2026.", values: [] },
    { ...answer, values: [{ ...answer.values[0]!, result: "r99" }] },
    { ...answer, summary: "Gross takings were {{missing}}." },
  ]) assert.equal(compose(candidate).ok, false);
});

test("known reporting date spans do not trigger false numeric failures", () => {
  for (const period of ["1–31 August 2026", "1-31 Aug 2026", "1 to 31 August 2026", "1 August 2026 to 31 August 2026"]) {
    const result = compose({ ...answer, detail: `The reporting period is ${period}.` });
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    assert.ok(result.answer.text.includes(period));
  }
  assert.equal(compose({ ...answer, detail: "The period is 1–31 August 2026. Profit was 31 dollars." }).ok, false);
});

test("the native final schema refuses hand-written table shells", () => {
  assert.equal(compose({ ...answer, detail: "| Period | Total |\n|---|---|" }).ok, false);
});

test("reference handles persist and never reinterpret business row values", () => {
  const refs = new ResultReferences();
  assert.equal(refs.register(id), "r1");
  assert.equal(refs.register(id), "r1");
  const value = refs.encode({ resultId: id, rows: [{ resultId: id, store: "r1" }] });
  assert.deepEqual(value, { resultId: "r1", rows: [{ resultId: id, store: "r1" }] });
  const next = new ResultReferences(refs.snapshot());
  assert.deepEqual(next.decode({ left: { resultId: "r1" }, query: { filters: [{ values: ["r1"] }] } }), { left: { resultId: id }, query: { filters: [{ values: ["r1"] }] } });
  assert.throws(() => next.decode({ resultId: "r99" }), /Unknown result/u);
});

test("native tools accept omitted nullable fields but validate nested constraints", async () => {
  const registry = createGovernedToolRegistry();
  registry.define({ name: "Query", description: "Test query", strict: true, parameters: omniQueryToolSchema, execute: async (input) => JSON.stringify(input) });
  const tool = registry.get(["Query"])[0]!;
  const minimal = { name: "Store sales", topic: "sales_analytics", query: { measures: ["sales_analytics.gross_takings"], filters: [{ member: "sales_analytics.store_name", operator: "equals", values: ["North"] }] } };
  const parsed = JSON.parse(String(await tool.invokeNative(minimal)));
  assert.equal(parsed.query.dimensions, null);
  assert.equal(parsed.query.filters[0].and, null);
  assert.equal(parsed.query.filters[0].or, null);
  await assert.rejects(tool.invokeNative({ ...minimal, unexpected: true }), NativeToolInputError);
  await assert.rejects(tool.invokeNative({ ...minimal, query: { ...minimal.query, filters: [{ member: "sales_analytics.store_name", operator: "invented", values: ["North"] }] } }), /filters\.0\.operator/u);
});

test("native tool parameter schemas use handles while the executor validates canonical IDs", async () => {
  const registry = createGovernedToolRegistry();
  registry.define({ name: "Inspect", description: "Inspect evidence", parameters: z.object({ resultId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u) }).strict(), strict: true, execute: async (value) => JSON.stringify(value) });
  const tool = registry.get(["Inspect"])[0]!;
  assert.equal((tool.parameters.properties as Record<string, { pattern: string }>).resultId!.pattern, "^r[1-9][0-9]{0,5}$");
  await assert.rejects(tool.invokeNative({ resultId: "r1" }), NativeToolInputError);
  assert.equal(JSON.parse(String(await tool.invokeNative({ resultId: id }))).resultId, id);
});

test("nullable defaulting never discards unknown fields or changes scalar values", () => {
  const schema = { type: "object", properties: { field: { anyOf: [{ type: "string" }, { type: "null" }] }, amount: { type: "number" } } };
  assert.deepEqual(fillNullableArguments(schema, { amount: "9", extra: "keep" }), { amount: "9", extra: "keep", field: null });
});

test("retention only selects this feature's expired, owned sessions", () => {
  const now = Date.now();
  const session = { metadata: { surface: MANAGED_SESSION_NAMESPACE, scope: "a".repeat(64) }, last_active_at: (now - MANAGED_SESSION_IDLE_MS - 1000) / 1000 } as AgentSession;
  assert.equal(isExpiredManagedSession(session, now), true);
  assert.equal(isExpiredManagedSession({ ...session, metadata: { ...session.metadata, surface: "another-app" } }, now), false);
  assert.equal(isExpiredManagedSession({ ...session, metadata: { surface: MANAGED_SESSION_NAMESPACE } }, now), false);
  assert.equal(isExpiredManagedSession({ ...session, last_active_at: now / 1000 }, now), false);
});

test("currency per recorded hour retains its currency while money ratios remain dimensionless", () => {
  const hours = { ...evidence, resultId: ulid(), columns: [{ key: "hours", label: "Actual hours", type: "number" as const }], rows: [{ hours: 20 }] };
  const left = { resultId: id, rowIndex: 0, columnKey: "gross" };
  const result = calculateValues({ caption: "Takings per hour", calculations: [
    { key: "hourly", label: "Gross takings per actual hour", kind: "ratio", left, right: { resultId: hours.resultId, rowIndex: 0, columnKey: "hours" } },
    { key: "money_ratio", label: "Money ratio", kind: "ratio", left, right: left },
  ] }, new Map<string, AnswerEvidence>([[id, evidence], [hours.resultId, hours]]));
  assert.ok(result.ok);
  assert.deepEqual(result.result.columns.map((column) => [column.type, column.currency]), [["currency", "AUD"], ["number", undefined]]);
  assert.equal(result.result.rows[0]!.hourly, 30);
});
