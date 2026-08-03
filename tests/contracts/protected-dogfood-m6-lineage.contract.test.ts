import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { seedGoldenQuestions } from "../../evals/golden/questions.js";

const migrationPath = new URL(
  "../../infra/migrations/control-plane/0063_m6_exact_answer_lineage_dogfood_gate.sql",
  import.meta.url,
);
const behavioralSqlPath = new URL(
  "../../tests/sql/control-plane-protected-dogfood-m6-lineage.sql",
  import.meta.url,
);

function taggedContract(sql: string, tag: "flagship" | "category"): Record<string, unknown> {
  const match = sql.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$::jsonb`, "u"));
  assert.ok(match?.[1], `The ${tag} SQL contract is missing.`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("M6 dogfood contracts pin the reviewed questions, lens, periods, dimensions, and IR", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const flagship = taggedContract(sql, "flagship");
  const category = taggedContract(sql, "category");
  const categoryGolden = seedGoldenQuestions.find(({ id }) => id === "sales-category");

  assert.ok(categoryGolden?.ir);
  assert.equal(
    flagship.initialQuestion,
    "Which of my employees working today performed best over the last six months?",
  );
  assert.equal(
    flagship.clarificationQuestion,
    "What should ‘performed best’ mean for this answer?",
  );
  assert.deepEqual(flagship.confirmation, {
    optionId: "employee.net_sales",
    label: "Net sales",
    preference: "employee.performance_default",
    value: "commerce.net_sales_ex_gst",
  });
  assert.deepEqual(flagship.rosterIr, {
    kind: "single",
    topic: "workforce_labour",
    metrics: ["rostered_hours"],
    dimensions: ["worker"],
    filters: [],
    time: { field: "business_date", range: { type: "today" }, compare: "none" },
    sort: [{ metric: "rostered_hours", dir: "desc" }],
    limit: 50,
    parameters: {},
  });
  assert.deepEqual(flagship.performanceIr, {
    kind: "composite",
    topic: "workforce_sales",
    metrics: ["sales_per_labour_hour"],
    alignOn: ["worker"],
    selectedLens: "net_sales_ex_gst",
    salesMetric: "net_sales_ex_gst",
    labourMetric: "worked_hours",
    rangeType: "absolute",
    rangeMonths: 6,
    sort: [{ metric: "net_sales_ex_gst", dir: "desc" }],
    limit: 50,
    parameters: {},
  });

  assert.equal(category.question, categoryGolden.question);
  assert.deepEqual(category.normalizedIr, {
    kind: "single",
    ...categoryGolden.ir,
    time: {
      field: "business_date",
      range: { type: "month_to_date" },
      compare: "none",
    },
  });
  assert.deepEqual(category.trace, {
    queryCount: 1,
    tableCount: 1,
    minimumNarrativeCount: 3,
    minimumValidationCount: 1,
    minimumChartCount: 1,
  });
});

test("M6 evidence recomputes result, trace, artefact, provenance, and lineage bindings", async () => {
  const [sql, attestation] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(new URL("../../scripts/dogfood-acceptance-attestation.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(sql, /dogfood_stable_json_sha256[\s\S]*'columns'[\s\S]*'rows'/u);
  assert.match(sql, /visible_result_digest IS DISTINCT FROM query_item->>'resultDigest'/u);
  assert.match(sql, /protected_dogfood_answer_artifact_digests[\s\S]*traceDigest[\s\S]*artifactDigest/u);
  assert.match(sql, /calculated_trace IS DISTINCT FROM artifact\.trace_digest/u);
  assert.match(sql, /calculated_artifact IS DISTINCT FROM artifact\.artifact_digest/u);
  assert.match(sql, /query_event_count IS DISTINCT FROM query_count/u);
  assert.match(sql, /source\.event IS NOT DISTINCT FROM event\.event_payload/u);
  assert.match(sql, /compilerOutputHash[\s\S]*semantic_plan_digest/u);
  assert.match(sql, /clarification_prompts[\s\S]*consumed_turn_id=artifact\.turn_id/u);
  assert.match(sql, /from_at\+interval '6 months' IS DISTINCT FROM to_at/u);
  assert.match(sql, /event_type='validation'[\s\S]*event_type='narrative'/u);
  assert.match(sql, /event_type='chart'[\s\S]*event_payload->>'dataRef'/u);
  assert.match(sql, /event_payload->'claims'[\s\S]*ref->>'columnKey'/u);
  assert.match(sql, /compiled_sql IS NOT NULL/u);
  assert.match(sql, /p_category_topic IS DISTINCT FROM 'sales_performance'/u);

  for (const field of [
    "contractVersion",
    "caseContractDigest",
    "questionDigest",
    "semanticPlanDigest",
    "traceContractDigest",
    "provenanceDigest",
    "lineageBindingDigest",
  ]) {
    assert.match(attestation, new RegExp(`${field}:`, "u"));
  }
  assert.match(attestation, /flagship:[\s\S]*queryCount: z\.literal\(2\)/u);
  assert.match(attestation, /category:[\s\S]*queryCount: z\.literal\(1\)/u);
});

test("stable JSON binding has the same canonical shape as the semantic service", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /ORDER BY entry\.key/u);
  assert.match(sql, /ORDER BY item\.ordinal/u);
  assert.match(sql, /to_jsonb\(entry\.key\)::text\|\|':'/u);
  assert.match(sql, /extensions\.digest[\s\S]*'sha256'/u);
});

test("the behavioral SQL exercises real finalization, the cross-runtime digest vector, and fail-closed cases", async () => {
  const sql = await readFile(behavioralSqlPath, "utf8");
  assert.equal(sql.match(/control_plane\.finalize_answer_artifact\(/gu)?.length, 3);
  assert.match(sql, /df226e26fdc23c041ab8eeda069bba3c6e6c959f6c0f3828f6c47c5794542453/u);
  assert.match(sql, /'flagship','sales_performance'/u);
  assert.match(sql, /'category','sales_performance'/u);
  assert.match(sql, /'category','sales'/u);
  assert.match(sql, /'flagship','sales_performance'[\s\S]*category artefact/u);
});
