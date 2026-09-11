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
import { formatReportingRange, formatReportingPeriodLabel } from "../../packages/shared/src/reporting-dates.js";

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

test("binding repairs identify the original name, valid columns and the single calculation row", () => {
  const wrongColumn = compose({ ...answer, values: [{ ...answer.values[0]!, column: "invented" }] });
  assert.ok(!wrongColumn.ok);
  assert.match(wrongColumn.issues.join(" "), /august_2026: r1 has no column invented.*store, gross/u);
  const wrongRow = compose({ ...answer, values: [{ ...answer.values[0]!, row: 5 }] });
  assert.ok(!wrongRow.ok);
  assert.match(wrongRow.issues.join(" "), /august_2026: r1 has 1 row.*row index is 0/u);
  const combined = compose({ ...answer, values: [{ ...answer.values[0]!, column: "invented" }], detail: "The period is 13 weeks." });
  assert.ok(!combined.ok);
  assert.match(combined.issues.join(" "), /august_2026: r1 has no column/u);
  assert.match(combined.issues.join(" "), /Unbound figures: 13/u);
});

test("unused planning bindings cannot reject the answer or create unsupported public claims", () => {
  const baseline = compose(answer);
  const result = compose({ ...answer, values: [...answer.values, { name: "unused", result: "r99", column: "invented", row: 5 }] });
  assert.ok(result.ok && baseline.ok);
  assert.deepEqual(result.answer, baseline.answer);
  assert.equal(compose({ ...answer, summary: "Gross takings were $999.00.", values: [{ name: "unused", result: "r1", column: "gross", row: 0 }] }).ok, false);
});

test("comparison date ranges and week counts are grounded without authorizing unrelated figures", () => {
  const compared = { ...evidence, provenance: { ...evidence.provenance, timeRange: { ...evidence.provenance.timeRange, start: "unknown", end: "unknown" } }, semantics: { ...evidence.semantics!, window: JSON.stringify({ ranges: [{ compareDateRange: [["2026-06-15", "2026-09-06"], ["2026-03-23", "2026-06-14"]] }] }) } };
  const render = (detail: string, limitations: string[] = []) => composeManagedAnswer({ ...answer, detail, limitations }, new Map([[id, compared]]), () => id, { ...options, question: "whats been driving the business lately" });
  const detail = "The last 12 complete weeks cover 15 June–6 September 2026, compared with 23 March–14 June 2026. This is a twelve-week comparison.";
  const limitation = "The preceding 12-week window is 23 March 2026 to 14 June 2026.";
  const result = render(detail, [limitation]);
  assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
  assert.ok(result.answer.text.includes(detail));
  assert.ok(result.answer.text.includes(limitation), "separate prose sections must restore their own dates");
  assert.equal(render(`${detail} Labour cost was 12 dollars.`).ok, false);
  assert.equal(render("The last 13 weeks explain the change.").ok, false);
});

test("negative changes cannot be described as a decrease by a negative amount", () => {
  const negative = new Map([[id, { ...evidence, rows: [{ store: "North", gross: -600 }] }]]);
  const render = (summary: string) => composeManagedAnswer({ ...answer, summary }, negative, () => id, options);
  assert.equal(render("Sales decreased by {{august_2026}}.").ok, false);
  const result = render("Sales had a change of {{august_2026}}.");
  assert.ok(result.ok);
  assert.match(result.answer.text, /change of -\$600\.00/u);
});

test("comparison periods show readable months while preserving partial and intraday scope", () => {
  assert.equal(formatReportingRange("2026-07-01T00:00:00.000 - 2026-07-31T23:59:59.999"), "July 2026");
  assert.equal(formatReportingRange("2024-02-01 to 2024-02-29"), "February 2024");
  assert.equal(formatReportingRange("2026-07-01 to 2026-07-15"), "1 July 2026–15 July 2026");
  assert.equal(formatReportingPeriodLabel("Comparing 2026-07-01 to 2026-07-31 vs 2026-08-01 to 2026-08-31"), "July 2026 vs August 2026");
  for (const value of ["2026-07-01T12:00:00.000 - 2026-07-31T23:59:59.999", "2026-02-01 to 2026-02-31", "2026-08-01 to 2026-07-31"]) assert.equal(formatReportingRange(value), value);
});

test("production Cube compareDateRange cells format as months without changing their numeric evidence", () => {
  for (const key of ["compareDateRange", "compare_date_range"]) {
    const source = { ...evidence, columns: [{ key, label: "Period", type: "string" as const }, evidence.columns[1]!], rows: [
      { [key]: "2026-07-01T00:00:00.000 - 2026-07-31T23:59:59.999", gross: 200 },
      { [key]: "2026-08-01T00:00:00.000 - 2026-08-31T23:59:59.999", gross: 600 },
    ] };
    const result = composeManagedAnswer({ ...answer, summary: "Monthly gross takings.", values: [], tables: [{ ...answer.tables[0]!, columns: [key, "gross"] }] }, new Map([[id, source]]), () => id, { ...options, question: "Show July and August 2026 gross takings." });
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    assert.match(result.answer.text, /\| July 2026 \| \$200\.00 \|/u);
    assert.match(result.answer.text, /\| August 2026 \| \$600\.00 \|/u);
    assert.ok(!result.answer.text.includes("T00:00"));
  }
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
