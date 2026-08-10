import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { sanitizeAnswerText, sanitizeTraceText } from "../../packages/shared/src/index.js";
import { renderAssistantMarkdown } from "../../app/dash/lib/render-assistant-markdown.js";

const liveRuntime = readFileSync(resolve("services/conversation/src/live.ts"), "utf8");

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
