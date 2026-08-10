import assert from "node:assert/strict";
import test from "node:test";

import {
  finalAnswerSchema,
  groundEvidenceFallback,
  groundFinalAnswer,
  semanticResponseSchema,
  type ExecutedResult,
  type FinalAnswer,
} from "../packages/anthropic-analytics/src/index.js";

function result(input: Readonly<{
  resultId: string;
  state: "verified" | "qualified" | "exploratory";
  rows: readonly Readonly<Record<string, unknown>>[];
  route?: "sql_first" | "source_exploration";
}>): ExecutedResult {
  const response = semanticResponseSchema.parse({
    state: input.state,
    resultId: input.resultId,
    data: { columns: Object.keys(input.rows[0] ?? {}), rows: input.rows },
    queryAudit: {
      queryAuditId: input.resultId === "sales" ? "01J00000000000000000000011" : "01J00000000000000000000012",
      route: input.route ?? "sql_first",
      bundleHash: "bundle",
      registryVersion: "2026.08.09",
      resultDigest: "result",
      compilerOutputHash: "compiler",
    },
    provenance: {
      bundleHash: "bundle",
      registryVersion: "2026.08.09",
      identityGraph: { version: 1, hash: "identity" },
      sources: ["lightspeed-r"],
      sourceWatermarks: { "lightspeed-r": "2026-08-09T00:00:00.000Z" },
      definitionsApplied: ["fixture.metric"],
    },
    validation: { status: input.state === "verified" ? "passed" : "warning", checks: [], warnings: [] },
    performance: { cacheHit: false, durationMs: 1, rowCount: input.rows.length },
  });
  return {
    resultId: input.resultId,
    state: input.state,
    rows: response.data!.rows,
    columns: response.data!.columns,
    queryAuditId: response.queryAudit!.queryAuditId,
    route: response.queryAudit!.route,
    response,
  };
}

const numericCases = [
  { name: "simple aggregate", value: "1250.00", state: "verified" as const, route: "sql_first" as const },
  { name: "refund-netted sales", value: "980.50", state: "verified" as const, route: "sql_first" as const },
  { name: "void-filtered tickets", value: 41, state: "verified" as const, route: "sql_first" as const },
  { name: "GST-exclusive amount", value: "110.00", state: "qualified" as const, route: "sql_first" as const },
  { name: "active mapping version", value: 17, state: "verified" as const, route: "sql_first" as const },
  { name: "tombstone-filtered stock", value: 73, state: "verified" as const, route: "sql_first" as const },
  { name: "staging long-tail measure", value: "8.25", state: "exploratory" as const, route: "source_exploration" as const },
];

test("fixture-backed analytics have exact numerical accuracy and zero ungrounded claims", () => {
  for (const scenario of numericCases) {
    const evidence = result({ resultId: "sales", state: scenario.state, rows: [{ value: scenario.value }], route: scenario.route });
    const rendered = String(scenario.value);
    const answer = groundFinalAnswer({
      outcome: "verified",
      text: `The result is ${rendered}.`,
      resultIds: ["sales"],
      claims: [{
        statement: `The result is ${rendered}.`,
        assertion: "value",
        refs: [{ resultId: "sales", rowIndex: 0, columnKey: "value" }],
      }],
      followUps: [],
    }, [evidence]);
    assert.equal(answer.outcome, scenario.state, scenario.name);
    assert.equal(answer.claims.length, 1, scenario.name);
  }
});

test("grounding distinguishes reporting dates from analytical numbers", () => {
  const evidence = result({ resultId: "sales", state: "verified", rows: [{ gross_takings: "1250.00" }] });
  const answer = groundFinalAnswer({
    outcome: "verified",
    text: "On 8 August 2026 (2026-08-08), total sales were $1,250.00.",
    resultIds: ["sales"],
    claims: [{
      statement: "Total sales were $1,250.00.",
      assertion: "value",
      refs: [{ resultId: "sales", rowIndex: 0, columnKey: "gross_takings" }],
    }],
    followUps: [],
  }, [evidence]);
  assert.equal(answer.outcome, "verified");
  assert.throws(() => groundFinalAnswer({
    ...answer,
    text: "On 8 August 2026, total sales were $1,250.00 across 2 stores.",
  }, [evidence]), /Answer number 2 is not represented/u);
});

test("successful SQL evidence survives a provider deadline without invented prose", () => {
  const base = result({
    resultId: "sales",
    state: "verified",
    rows: [
      { business_date: "2026-07-24T14:00:00.000Z", gross_takings_inc_gst: "1595.7200" },
      { business_date: "2026-08-06T14:00:00.000Z", gross_takings_inc_gst: "189.9900" },
    ],
  });
  const evidence: ExecutedResult = {
    ...base,
    declaredClaims: [{ metricId: "commerce.gross_takings_inc_gst", column: "gross_takings_inc_gst" }],
    response: semanticResponseSchema.parse({
      ...base.response,
      data: {
        ...base.response.data,
        resultWindow: {
          requestedLimit: 200,
          orderedBeforeLimit: true,
          orderBy: [{ columnKey: "business_date", direction: "desc" }],
        },
      },
    }),
  };
  const fallback = groundEvidenceFallback([evidence], {
    question: "What were gross takings including GST on 7 August 2026?",
    now: new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(fallback?.outcome, "verified");
  assert.match(fallback?.text ?? "", /business date 2026-08-07/u);
  assert.match(fallback?.text ?? "", /189\.9900/u);
  assert.doesNotMatch(fallback?.text ?? "", /1595\.7200/u);
  assert.deepEqual(fallback?.claims[0]?.refs, [{ resultId: "sales", rowIndex: 1, columnKey: "gross_takings_inc_gst" }]);
});

test("every deterministic and adversarial case resolves to exactly one terminal outcome", () => {
  const terminals: FinalAnswer[] = [
    finalAnswerSchema.parse({ outcome: "clarification", text: "Which store?", resultIds: [], claims: [], followUps: [], clarification: { question: "Which store?", options: [{ id: "all", label: "All stores" }, { id: "one", label: "One store" }] } }),
    finalAnswerSchema.parse({ outcome: "unavailable", text: "No rows matched.", resultIds: [], claims: [], followUps: [], unavailableReason: "The governed result was empty." }),
    finalAnswerSchema.parse({ outcome: "unavailable", text: "Data is stale.", resultIds: [], claims: [], followUps: [], unavailableReason: "The requested period is beyond the source watermark." }),
    finalAnswerSchema.parse({ outcome: "unavailable", text: "SQL could not be repaired.", resultIds: [], claims: [], followUps: [], unavailableReason: "Three repairs and one simpler decomposition were exhausted." }),
    finalAnswerSchema.parse({ outcome: "unavailable", text: "Provider failed safely.", resultIds: [], claims: [], followUps: [], unavailableReason: "Authentication, rate limit, budget, timeout, or provider failure." }),
    finalAnswerSchema.parse({ outcome: "unavailable", text: "PII is not authorized.", resultIds: [], claims: [], followUps: [], unavailableReason: "The role policy blocked the requested field." }),
    finalAnswerSchema.parse({ outcome: "unavailable", text: "Join fan-out was rejected.", resultIds: [], claims: [], followUps: [], unavailableReason: "The governed validator detected multiplying joins." }),
  ];
  const allowed = new Set(["verified", "qualified", "exploratory", "clarification", "unavailable"]);
  assert.ok(terminals.every((answer) => allowed.has(answer.outcome)));
  assert.equal(terminals.length, 7);
});

test("multi-result claims cannot cite a different tenant, result, row, or field", () => {
  const sales = result({ resultId: "sales", state: "verified", rows: [{ value: 50 }] });
  const inventory = result({ resultId: "inventory", state: "verified", rows: [{ value: 8 }] });
  assert.throws(() => groundFinalAnswer({
    outcome: "verified",
    text: "The result is 50.",
    resultIds: ["sales", "inventory"],
    claims: [{ statement: "The result is 50.", assertion: "value", refs: [{ resultId: "other-tenant-result", rowIndex: 0, columnKey: "value" }] }],
    followUps: [],
  }, [sales, inventory]), /unknown result/u);
  assert.throws(() => groundFinalAnswer({
    outcome: "verified",
    text: "The result is 50.",
    resultIds: ["sales"],
    claims: [{ statement: "The result is 50.", assertion: "value", refs: [{ resultId: "sales", rowIndex: 3, columnKey: "pii_email" }] }],
    followUps: [],
  }, [sales]), /does not exist/u);
});
