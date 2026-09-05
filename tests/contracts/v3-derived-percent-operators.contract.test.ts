import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { TRACE_DERIVED_CALCULATION_OPERATORS } from "../../packages/shared/src/index.js";
import { materializeDerivedTable } from "../../packages/albert-v3/src/engine/derived-table.js";
import { presentedAnswerTableIds } from "../../packages/albert-v3/src/engine/engine.js";
import { dashboardDerivationSchema } from "../../services/control-plane/src/dashboard-repository.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const source = {
  resultId: "cmp",
  columns: [
    { key: "period", label: "Period", type: "string" as const },
    { key: "sales", label: "Sales", type: "currency" as const, currency: "AUD" },
  ],
  rows: [
    { period: "1–18 Aug 2026", sales: 15668.34 },
    { period: "1–18 Aug 2025", sales: 32197.68 },
    { period: "empty", sales: 0 },
  ],
};

function cell(rowIndex: number) {
  return { kind: "source" as const, sourceResultId: "cmp", rowIndex, columnKey: "sales" };
}

function derivation(operator: (typeof TRACE_DERIVED_CALCULATION_OPERATORS)[number], left: number, right: number) {
  return {
    version: "derived_table_v1" as const,
    sources: [{ tableEventId: "01KZN20VTX2EWW1TQ2AA3MCPW7", resultId: "cmp" }],
    columns: [{ key: "value", label: "Value", type: "percent" as const }],
    rows: [{ cells: [{
      columnKey: "value",
      expression: { kind: "calculation" as const, operator, left: cell(left), right: cell(right) },
    }] }],
  };
}

test("percent_change and percent_of are 0-100 scale and null on a zero denominator", () => {
  const change = materializeDerivedTable(derivation("percent_change", 0, 1), [source], "Australia/Melbourne");
  assert.equal(Math.round((change.rows[0]!.value as number) * 100) / 100, -51.34);

  const share = materializeDerivedTable(derivation("percent_of", 0, 1), [source], "Australia/Melbourne");
  assert.equal(Math.round((share.rows[0]!.value as number) * 100) / 100, 48.66);

  const zeroChange = materializeDerivedTable(derivation("percent_change", 0, 2), [source], "Australia/Melbourne");
  assert.equal(zeroChange.rows[0]!.value, null);
  const zeroShare = materializeDerivedTable(derivation("percent_of", 0, 2), [source], "Australia/Melbourne");
  assert.equal(zeroShare.rows[0]!.value, null);
});

test("the control-plane replay schema accepts exactly the shared operator set", () => {
  for (const operator of TRACE_DERIVED_CALCULATION_OPERATORS) {
    const parsed = dashboardDerivationSchema.safeParse(derivation(operator, 0, 1));
    assert.ok(parsed.success, `${operator} must replay on the dashboard`);
  }
  const bogus = dashboardDerivationSchema.safeParse({
    ...derivation("add", 0, 1),
    rows: [{ cells: [{
      columnKey: "value",
      expression: { kind: "calculation", operator: "power", left: cell(0), right: cell(1) },
    }] }],
  });
  assert.equal(bogus.success, false);
  // The control plane deliberately keeps its own copy of the enum; keep the
  // literal list identical to the shared constant.
  const repository = read("services/control-plane/src/dashboard-repository.ts");
  const literal = repository.match(/operator: z\.enum\(\[([^\]]+)\]\)/u)?.[1] ?? "";
  const listed = [...literal.matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(listed, [...TRACE_DERIVED_CALCULATION_OPERATORS]);
});

test("compose_table echoes a preview so the model can check its own calculations", () => {
  const tools = read("packages/albert-v3/src/engine/tools.ts");
  assert.match(tools, /preview: \{\s*columns: previewColumns/u);
  assert.match(tools, /operator: z\.enum\(TRACE_DERIVED_CALCULATION_OPERATORS\)/u);
  const lanes = read("packages/albert-v3/src/engine/lanes.ts");
  assert.match(lanes, /percent_change operator/u);
});

test("a table re-composed under the same caption replaces the earlier version in the answer", () => {
  const ids = presentedAnswerTableIds([
    { resultId: "e1", caption: "Like-for-like sales", presentation: "evidence" },
    { resultId: "a1", caption: "Like-for-like sales comparison, 1–18 August", presentation: "answer" },
    { resultId: "a2", caption: "Corrected like-for-like sales comparison, 1–18 August", presentation: "answer" },
    { resultId: "a3", caption: "Top products", presentation: "answer" },
    { resultId: "a4", caption: "Final corrected like-for-like sales comparison, 1–18 August", presentation: "answer" },
  ]);
  assert.deepEqual(ids, ["a3", "a4"]);

  // Distinct tables keep the last three, in composition order.
  const distinct = presentedAnswerTableIds(
    ["A", "B", "C", "D"].map((caption, index) => ({ resultId: `t${index}`, caption, presentation: "answer" as const })),
  );
  assert.deepEqual(distinct, ["t1", "t2", "t3"]);
});
