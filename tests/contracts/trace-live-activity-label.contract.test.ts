import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// InsightsStyleTrace.tsx imports a CSS module, which node cannot load; the
// hook substitutes an empty module for stylesheets before the dynamic import.
registerHooks({
  load(url, context, next) {
    if (url.split("?")[0].endsWith(".css")) {
      return { format: "module", source: "export default {};", shortCircuit: true };
    }
    return next(url, context);
  },
});

const { liveActivityLabel, summarizeActivity } = await import("../../app/dash/components/InsightsStyleTrace.tsx");

type Step = {
  title: string;
  detail?: string;
  status: "running" | "done" | "error" | "incomplete";
  stage?: string;
  kind: "sql" | "tool";
};

const running = (title: string, detail = "", stage = "planning", kind: Step["kind"] = "tool"): Step =>
  ({ title, detail, status: "running", stage, kind });

test("the live activity line names the lookup in flight, never a query count", () => {
  const label = liveActivityLabel([
    running(
      "Querying Monthly sales and gross profit for the current year to date",
      "sales_analytics.gross_takings, sales_analytics.gross_profit",
      "query",
    ),
  ]);
  assert.equal(label, "Looking up monthly sales and gross profit for the current year to date…");
  assert.doesNotMatch(String(label), /Ran \d+ quer/u);
});

test("runtime status titles rewrite to owner copy without internal names", () => {
  const expectations: ReadonlyArray<readonly [string, string, string]> = [
    ["Codex is planning the analysis", "Using Albert’s governed semantic catalogue", "Planning the analysis…"],
    ["Albert is reviewing the draft against the ask", "An independent check that every part of the question is answered", "Checking the draft against your question…"],
    ["Albert checked the draft — Codex is repairing it", "A draft figure did not match a governed result cell.", "Correcting the draft…"],
    ["Albert is tightening the answer to the ask", "Cutting anything the question did not ask for; figures stay byte-identical", "Tightening the answer…"],
    ["Codex is composing and verifying the answer", "Every figure is checked against governed result cells before it is shown", "Writing up the answer…"],
    ["Codex is mapping the question to the governed data", "Choosing the views and measures that answer this", "Choosing the data that answers this…"],
    ["Codex is analysing the evidence", "3 governed queries run so far", "Analysing the evidence…"],
  ];
  for (const [title, detail, expected] of expectations) {
    const label = liveActivityLabel([running(title, detail)]);
    assert.equal(label, expected, title);
    assert.doesNotMatch(String(label), /albert|codex|governed/iu, title);
  }
});

test("generic or settled steps fall back to the counted summary", () => {
  // "Running SQL" softens to a generic theme, so the group keeps its count.
  assert.equal(liveActivityLabel([running("Running SQL", "", "query", "sql")]), null);
  // Nothing running: the settled record is the label.
  const settled: Step[] = [
    { title: "Monthly sales", status: "done", stage: "query", kind: "sql" },
    { title: "Prior-year sales", status: "done", stage: "query", kind: "sql" },
  ];
  assert.equal(liveActivityLabel(settled), null);
  assert.equal(summarizeActivity(settled), "Ran 2 queries");
});
