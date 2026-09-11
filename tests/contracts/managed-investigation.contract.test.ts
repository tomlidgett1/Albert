import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";
import { ManagedDiscoveryBudget, ManagedInvestigationBudget } from "../../packages/albert-agents-api/src/investigation-budget.js";
import { calculateValues, calculateValuesSchema } from "../../packages/albert-omni/src/calculate.js";
import type { PivotSourceResult } from "../../packages/albert-omni/src/pivot.js";

test("repeated discovery must yield to a data query and cannot bypass the total allowance", () => {
  const budget = new ManagedDiscoveryBudget();
  for (let queries = 0; queries < 4; queries++) {
    for (let lookup = 0; lookup < 3; lookup++) assert.equal(budget.admit(queries), undefined);
    assert.match(budget.admit(queries)!, /paused|allowance/u);
  }
  assert.match(budget.admit(100)!, /allowance is spent/u);
});

test("investigations leave time for an answer and preserve the no-evidence distinction", () => {
  const budget = new ManagedInvestigationBudget(1000, 721000);
  assert.equal(budget.guidance(101000, 10, true), undefined);
  assert.match(budget.guidance(181000, 10, true)!, /recorded evidence/u);
  assert.match(budget.guidance(101000, 24, true)!, /recorded evidence/u);
  assert.match(budget.guidance(181000, 10, false)!, /Do not invent figures/u);
  const short = new ManagedInvestigationBudget(1000, 61000);
  assert.equal(short.guidance(40000, 1, true), undefined);
  assert.match(short.guidance(44000, 1, true)!, /Finish this response/u);
});

test("the 31-calculation batch from the failed overview fits one bounded exact operation", () => {
  const id = ulid();
  const source: PivotSourceResult = {
    resultId: id, topic: "Recorded sales", columns: [{ key: "takings", label: "Takings", type: "currency", currency: "AUD" }], rows: [{ takings: 600 }, { takings: 200 }],
    provenance: { sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-08-31" }], timeRange: { label: "July vs August 2026", start: "2026-07-01", end: "2026-08-31", timezone: "Australia/Melbourne" }, definitions: [], semanticBundleHash: "fixture", identityGraph: { version: 0, hash: "fixture" } },
  };
  const input = { caption: "Business changes", calculations: Array.from({ length: 31 }, (_, i) => ({ key: `change_${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`, label: "Recorded change", kind: "difference" as const, left: { resultId: id, columnKey: "takings", rowIndex: 0 }, right: { resultId: id, columnKey: "takings", rowIndex: 1 } })) };
  const result = calculateValues(input, new Map([[id, source]]));
  assert.ok(result.ok);
  assert.equal(result.result.columns.length, 31);
  assert.ok(Object.values(result.result.rows[0]!).every((value) => value === 400));
  const oversized = calculateValuesSchema.safeParse({ ...input, calculations: [...input.calculations, input.calculations[0], input.calculations[1]] });
  assert.equal(oversized.success, false);
  if (!oversized.success) assert.match(oversized.error.issues[0]!.message, /at most 32/u);
  const invalid = calculateValues({ ...input, calculations: [...input.calculations.slice(0, -1), { ...input.calculations.at(-1)!, right: { resultId: id, columnKey: "not_recorded", rowIndex: 1 } }] }, new Map([[id, source]]));
  assert.equal(invalid.ok, false, "an invalid tail reference must reject the whole batch");
});

test("margin differences use percentage points and preserve ratio-scale sums", () => {
  for (const scale of ["percent", "ratio"] as const) {
    const id = ulid();
    const source: PivotSourceResult = { resultId: id, topic: "Margin", columns: [{ key: "margin", label: "Margin", type: "percent", percentScale: scale }], rows: [{ margin: scale === "ratio" ? 0.3 : 30 }, { margin: scale === "ratio" ? 0.25 : 25 }], provenance: { sources: [], timeRange: { label: "Compared periods", start: "2026-07-01", end: "2026-08-31", timezone: "UTC" }, definitions: [], semanticBundleHash: "fixture", identityGraph: { version: 0, hash: "fixture" } } };
    const left = { resultId: id, rowIndex: 0, columnKey: "margin" }, right = { ...left, rowIndex: 1 };
    const result = calculateValues({ caption: "Margin movement", calculations: [{ key: "change", label: "Margin change", kind: "difference", left, right }, { key: "sum", label: "Sum", kind: "sum", left, right }] }, new Map([[id, source]]));
    assert.ok(result.ok);
    assert.equal(result.result.rows[0]!.change, 5);
    assert.equal(result.result.columns[0]!.type, "number");
    assert.match(result.result.columns[0]!.label, /percentage points/u);
    assert.equal(result.result.columns[1]!.percentScale, scale);
  }
});
