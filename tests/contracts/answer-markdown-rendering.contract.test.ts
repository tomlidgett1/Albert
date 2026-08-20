import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { sanitizeAnswerText, sanitizeTraceText } from "../../packages/shared/src/index.js";
import {
  renderAssistantMarkdown,
  splitAssistantMarkdownLead,
} from "../../app/dash/lib/render-assistant-markdown.js";

const liveRuntime = readFileSync(resolve("services/conversation/src/live.ts"), "utf8");
const v3EngineRuntime = readFileSync(resolve("packages/albert-v3/src/engine/engine.ts"), "utf8");
const traceStyles = readFileSync(
  resolve("app/dash/components/insights-trace.module.css"),
  "utf8",
);

/** The shape an answer takes when the governed result is genuinely tabular. */
const tabularAnswer = `Services carries the margin, Wheels & Tyres the volume.

| Category | Net sales | Gross margin % |
| --- | --- | --- |
| Services | $21,662.82 | 97.9% |
| Wheels & Tyres | $12,701.41 | 53.4% |

Margin is hiding in Services.`;

test("answer prose keeps the line structure its markdown depends on", () => {
  const sanitized = sanitizeAnswerText(tabularAnswer, 4_000);
  assert.ok(sanitized.includes("\n"), "answer sanitization must not collapse newlines");
  assert.equal(
    sanitized.split("\n").filter((line) => line.startsWith("|")).length,
    4,
    "every table row must survive on its own line",
  );
  // Trace copy is single-line by contract and must keep collapsing.
  assert.ok(!sanitizeTraceText(tabularAnswer, 4_000).includes("\n"));
  // The bounds trace copy carries still apply to an answer.
  assert.equal(sanitizeAnswerText("x".repeat(50), 10).length, 10);
  assert.equal(sanitizeAnswerText("ab\r\nc  d   \n\n\n\ne"), "ab\nc d\n\ne");
});

test("a tabular answer renders as a table rather than loose pipes", () => {
  const html = renderAssistantMarkdown(sanitizeAnswerText(tabularAnswer, 4_000));
  assert.match(html, /<table>/, "a governed data table must reach the reader as a table");
  assert.match(html, /<th>Category<\/th><th>Net sales<\/th><th>Gross margin %<\/th>/);
  assert.match(html, /<td>Services<\/td><td>\$21,662\.82<\/td><td>97\.9%<\/td>/);
  assert.doesNotMatch(html, /<p>[^<]*\|/, "no table row may fall back to pipe-laden prose");
});

test("table parsing accepts the separator widths models actually write", () => {
  for (const separator of ["|-|-|", "| -- | -- |", "| --- | --- |", "|:---|---:|", "--- | ---"]) {
    const html = renderAssistantMarkdown(`| P | R |\n${separator}\n| A | 10 |`);
    assert.match(html, /<table>/, `separator "${separator}" must open a table`);
  }
});

test("cells stay in their column when a row is ragged or carries a pipe", () => {
  const ragged = renderAssistantMarkdown("| P | R | M |\n| --- | --- | --- |\n| A | 10 |");
  assert.match(ragged, /<tr><td>A<\/td><td>10<\/td><td><\/td><\/tr>/);

  const escaped = renderAssistantMarkdown("| P | R |\n| --- | --- |\n| A \\| B | 10 |");
  assert.match(escaped, /<tr><td>A \| B<\/td><td>10<\/td><\/tr>/);

  // Untrusted governed labels stay inert inside a rendered cell.
  const hostile = renderAssistantMarkdown("| P | R |\n| --- | --- |\n| <img src=x onerror=alert(1)> | 1 |");
  assert.doesNotMatch(hostile, /<img/);
});

test("prose containing a pipe is not mistaken for a table", () => {
  const html = renderAssistantMarkdown(sanitizeAnswerText("Sales rose | margin fell.\nThat is the trade-off."));
  assert.doesNotMatch(html, /<table>/);
  assert.match(html, /<p>Sales rose \| margin fell\. That is the trade-off\.<\/p>/);
});

test("long answers render explicit headings and lists as a scannable report", () => {
  const html = renderAssistantMarkdown(`The setup is broadly sound, with two items to review.

## Priorities

- **Review the lock date.** It is older than expected.
- **Confirm the account class.** Motor vehicles may be misclassified.

## Next steps

1. Check the lock date
2. Review the asset accounts`);

  assert.match(html, /<h2>Priorities<\/h2>/);
  assert.match(html, /<ul><li><strong>Review the lock date\.<\/strong>/);
  assert.match(html, /<h2>Next steps<\/h2>/);
  assert.match(html, /<ol><li>Check the lock date<\/li><li>Review the asset accounts<\/li><\/ol>/);
});

test("legacy bare report labels become headings without promoting ordinary prose", () => {
  const html = renderAssistantMarkdown(`The setup is broadly sound.

What is sound

The organisation details are complete.

Issues to fix or confirm

Review the period lock date.

What is not covered

Payroll was not assessed.`);

  assert.match(html, /<h2>What is sound<\/h2>/);
  assert.match(html, /<h2>Issues to fix or confirm<\/h2>/);
  assert.match(html, /<h2>What is not covered<\/h2>/);
  assert.doesNotMatch(renderAssistantMarkdown("Ashburton Cycles\n\nRecorded in Xero."), /<h[1-6]>/);
  assert.doesNotMatch(renderAssistantMarkdown("What happened?\n\nSales rose."), /<h[1-6]>/);
  assert.doesNotMatch(renderAssistantMarkdown("Key Bikes\n\nSold 4 units."), /<h[1-6]>/);
  assert.doesNotMatch(renderAssistantMarkdown("What Women Want\n\nSold 2 units."), /<h[1-6]>/);
});

test("a structured answer table can sit after the takeaway and before report detail", () => {
  assert.deepEqual(
    splitAssistantMarkdownLead(`The setup is broadly sound, with two items to review.

## Priorities

- Review the lock date
- Confirm the account class`),
    {
      lead: "The setup is broadly sound, with two items to review.",
      detail: "## Priorities\n\n- Review the lock date\n- Confirm the account class",
    },
  );
  assert.deepEqual(splitAssistantMarkdownLead("Sales were $42 yesterday."), {
    lead: "Sales were $42 yesterday.",
    detail: "",
  });
  assert.deepEqual(
    splitAssistantMarkdownLead(`Leigh Phillips worked the most over 6-19 August, with **66 hours**.

The timesheet data is current through Sunday 16 August, so the final three days of the requested period are not yet included.`),
    {
      lead: "Leigh Phillips worked the most over 6-19 August, with **66 hours**.",
      detail: "The timesheet data is current through Sunday 16 August, so the final three days of the requested period are not yet included.",
    },
  );

  const traceSurface = readFileSync(resolve("app/dash/components/InsightsStyleTrace.tsx"), "utf8");
  const leadPosition = traceSurface.indexOf("content={answerSections?.lead || model.answer.text}");
  const tablePosition = traceSurface.indexOf("model.answerTables.map");
  const detailPosition = traceSurface.indexOf("content={answerSections.detail}");
  assert.ok(leadPosition >= 0 && leadPosition < tablePosition);
  assert.ok(tablePosition < detailPosition);
});

test("assistant report spacing wins the chat reset and follows the text scale", () => {
  assert.match(traceStyles, /\.answerBlock \.assistantProse :global\(p\)/u);
  assert.match(traceStyles, /font-size: calc\(16px \* var\(--text-scale\)\)/u);
  assert.match(traceStyles, /\.assistantProse :global\(p\),\s*\n\.assistantProse :global\(li\) \{\s*\n  font-size: calc\(16px \* var\(--text-scale\)\)/u);
  assert.match(traceStyles, /list-style-type: disc/u);
  assert.match(traceStyles, /list-style-type: decimal/u);
});

test("the v3 contract requires clean Markdown structure without Markdown tables", () => {
  const laneRuntime = readFileSync(resolve("packages/albert-v3/src/engine/lanes.ts"), "utf8");
  assert.match(laneRuntime, /Clean Markdown prose/u);
  assert.match(laneRuntime, /organise the detail under descriptive \\`##\\` headings/u);
  assert.match(laneRuntime, /use bullets for distinct findings/u);
  assert.match(laneRuntime, /numbered list for prioritised actions/u);
  assert.match(laneRuntime, /Never write a Markdown pipe table/u);
  assert.doesNotMatch(laneRuntime, /Prose only\. Never include/u);
  assert.match(v3EngineRuntime, /Preserve the draft's headings,/u);
  assert.doesNotMatch(v3EngineRuntime, /short prose only/u);
});

test("the runtime sanitizes prose but leaves owner-visible table selection to the analyst", () => {
  // Each initial or repaired draft goes through the same 12k transformation
  // boundary; the persisted narrative remains bounded at 16k.
  assert.match(
    liveRuntime,
    /let answerText = sanitizeAnswerText\(\s*stripRedundantChartMarkup\(draft\.text, chartResultIds\.size > 0\),\s*12_000,\s*\)/u,
  );
  assert.doesNotMatch(liveRuntime, /answerText = sanitizeTraceText\(output\.text/u);
  assert.match(liveRuntime, /markdown pipe table/u);
  assert.doesNotMatch(liveRuntime, /answerText = ensureAnswerIncludesTable\(/u);
  assert.match(liveRuntime, /Table selection belongs to the analyst's presentation output/u);
  assert.match(liveRuntime, /draft\.presentation\.resultIds/u);
  assert.match(liveRuntime, /isOwnerTrailValidation/u);
});
