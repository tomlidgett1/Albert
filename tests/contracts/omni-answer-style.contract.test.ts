import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";
import { ANSWER_NOTE_PREFIX, COMPOSE_ANSWER_INSTRUCTIONS, composeAnswer, type AnswerEvidence, type ComposeAnswerInput } from "../../packages/albert-omni/src/answer.js";
import { renderOmniInstructions } from "../../packages/albert-omni/src/prompts.js";
import { stripScopedCalendarDates } from "../../packages/shared/src/reporting-dates.js";
import { renderAssistantMarkdown } from "../../app/dash/lib/render-assistant-markdown.js";
import type { ResultSemantics, TraceTableColumn } from "../../packages/shared/src/index.js";

/**
 * How an Omni answer READS. The owner's complaint (2026-09-19) was that a
 * throwaway question came back as a thousand-word report with cents on every
 * figure, field labels for table headers, the same caveat three times, and a
 * closure "date" that was never named. Each rule here is one of those defects
 * made impossible by the composer rather than merely discouraged in a prompt.
 */

const semantics = (grain: readonly string[], completeness: ResultSemantics["completeness"] = "complete", extra: Partial<ResultSemantics> = {}): ResultSemantics => ({
  version: 1, completeness, returnedRows: 0, rowLimit: 500, grain: [...grain], keys: {},
  window: "fixture", queryDigest: "q".repeat(64), semanticVersionDigest: "s".repeat(64), ...extra,
});
const evidence = (columns: TraceTableColumn[], rows: Record<string, unknown>[], meta: ResultSemantics = semantics([]), extra: Partial<AnswerEvidence> = {}): AnswerEvidence => ({
  resultId: ulid(), topic: "Fixture", columns, rows: rows as AnswerEvidence["rows"], semantics: meta,
  provenance: { sources: [{ connector: "lightspeed", label: "Fixture", dataThrough: "2026-09-18" }], timeRange: { label: "last 14 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" }, definitions: [], semanticBundleHash: "fixture", identityGraph: { version: 0, hash: "fixture" } },
  ...extra,
});
const options = { question: "How is the business going?", today: "Today is Saturday, 19 September 2026 (2026-09-19)." };
const base = { outcome: "answer" as const, values: [], tables: [], limitations: [], followUps: [] };
const compose = (source: AnswerEvidence, input: Partial<ComposeAnswerInput> & { markdown: string }, overrides: Partial<typeof options> = {}) =>
  composeAnswer({ ...base, citedResultIds: [source.resultId], ...input }, new Map([[source.resultId, source]]), { ...options, ...overrides });
const text = (result: ReturnType<typeof compose>): string => {
  assert.ok(result.ok, result.ok ? "" : result.issues.join(" | "));
  return result.answer.text;
};
const value = (source: AnswerEvidence, id: string, columnKey: string, rowIndex = 0, format: "auto" | "compact" = "auto") => ({ id, resultId: source.resultId, rowIndex, columnKey, format, decimals: null });

const money: TraceTableColumn = { key: "sales", label: "Gross takings (inc tax)", type: "currency", currency: "AUD" };

test("money reads as whole dollars from $1,000 and keeps its cents below that", () => {
  const source = evidence([money, { key: "avg", label: "Average sale value", type: "currency", currency: "AUD" }], [{ sales: 19435.48, avg: 308.5 }]);
  assert.equal(text(compose(source, { markdown: "Sales were {{sales}} at {{avg}} a sale.", values: [value(source, "sales", "sales"), value(source, "avg", "avg")] })),
    "Sales were $19,435 at $308.50 a sale.");
});

test("compact figures are written the way people write them", () => {
  const source = evidence([money], [{ sales: 3741.2 }, { sales: 1_234_567 }, { sales: 950 }]);
  assert.equal(text(compose(source, { markdown: "{{a}}, {{b}} and {{c}}.", values: [value(source, "a", "sales", 0, "compact"), value(source, "b", "sales", 1, "compact"), value(source, "c", "sales", 2, "compact")] })),
    "$3.7k, $1.2M and $950.");
});

test("a money column holds one precision, set by its largest figure", () => {
  const source = evidence([{ key: "item", label: "Item name", type: "string" }, money], [{ item: "Izalco Max", sales: 7199.2 }, { item: "Carpe 40", sales: 824.99 }]);
  const answer = text(compose(source, { markdown: "Top sellers:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Product", "Revenue"], limit: 10 }] }));
  assert.match(answer, /\| Izalco Max \| \$7,199 \|/u);
  assert.match(answer, /\| Carpe 40 \| \$825 \|/u);
  // A column of small amounts is where cents still matter.
  const small = evidence([{ key: "item", label: "Item", type: "string" }, money], [{ item: "Tube", sales: 12.5 }, { item: "Patch kit", sales: 8 }]);
  assert.match(text(compose(small, { markdown: "Small lines:\n\n{{t}}", tables: [{ id: "t", resultId: small.resultId, columnKeys: ["item", "sales"], limit: 10 }] })), /\| Tube \| \$12\.50 \|\n\| Patch kit \| \$8\.00 \|/u);
});

test("percentages carry one decimal and counts only the precision they have", () => {
  const source = evidence([
    { key: "margin", label: "Gross margin %", type: "percent", percentScale: "percent" },
    { key: "growth", label: "Growth", type: "percent", percentScale: "ratio" },
    { key: "hours", label: "Hours worked", type: "number" },
    { key: "tx", label: "Transactions", type: "number" },
  ], [{ margin: 59.76, growth: 1.3195, hours: 342.32, tx: 81 }]);
  assert.equal(text(compose(source, { markdown: "{{m}} margin, {{g}} growth, {{h}} hours, {{t}} sales.", values: [value(source, "m", "margin"), value(source, "g", "growth"), value(source, "h", "hours"), value(source, "t", "tx")] })),
    "59.8% margin, 132% growth, 342.3 hours, 81 sales.");
});

test("small amounts are never half-abbreviated, and a column shares one precision", () => {
  const source = evidence([{ key: "week", label: "Week", type: "string" }, { key: "hours", label: "Hours worked", type: "number" }, { key: "share", label: "Labour share", type: "percent", percentScale: "percent" }, { key: "staff", label: "Staff", type: "number" }, { key: "delta", label: "Change", type: "currency", currency: "AUD" }],
    [{ week: "20 Jul", hours: 85.37, share: 20.31, staff: 4, delta: -480.6 }, { week: "27 Jul", hours: 75.5, share: 18, staff: 3, delta: 95.5 }]);
  const answer = text(compose(source, {
    markdown: "Wage cost fell by {{d}}, then rose {{u}}.\n\n{{t}}",
    values: [value(source, "d", "delta", 0, "compact"), value(source, "u", "delta", 1, "compact")],
    tables: [{ id: "t", resultId: source.resultId, columnKeys: ["week", "hours", "share", "staff"], headers: ["Week", "Hours", "Labour %", "Staff"], limit: 10 }],
  }));
  assert.match(answer, /^Wage cost fell by \$481, then rose \$95\.50\./u);
  assert.match(answer, /\| 20 Jul \| 85\.4 \| 20\.3% \| 4 \|\n\| 27 Jul \| 75\.5 \| 18\.0% \| 3 \|/u);
});

test("a statement's total lines are emphasised so the renderer can rule them off", () => {
  const source = evidence([{ key: "metric", label: "Metric", type: "string" }, { key: "aug", label: "1 Aug 2026", type: "number" }, { key: "jul", label: "1 July 2026", type: "number" }],
    [{ metric: "Sales revenue", aug: 41768.97, jul: 42016.69 }, { metric: "Gross profit", aug: 21771.58, jul: 25108.57 }, { metric: "Total operating expenses", aug: 16163.97, jul: 24666.92 }, { metric: "Net profit", aug: 5607.61, jul: null }],
    semantics(["metric"], "complete", { inputGrains: [["xero_pnl.period.month"]] }), { rowFormats: Array.from({ length: 4 }, () => ({ type: "currency" as const, currency: "AUD" })) });
  const answer = text(compose(source, { markdown: "August made money.\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["metric", "aug", "jul"], headers: null, limit: 10 }] }));
  assert.match(answer, /\| Sales revenue \| \$41,769 \| \$42,017 \|/u);
  assert.match(answer, /\| \*\*Gross profit\*\* \| \*\*\$21,772\*\* \| \*\*\$25,109\*\* \|/u);
  assert.match(answer, /\| \*\*Total operating expenses\*\* \|/u);
  // A missing cell stays blank rather than a bold nothing.
  assert.match(answer, /\| \*\*Net profit\*\* \| \*\*\$5,608\*\* \| \|$/mu);
  assert.match(renderAssistantMarkdown(answer), /<td><strong>Net profit<\/strong><\/td>/u);

  // A scorecard that merely lists Net profit and a margin is not a statement.
  const scorecard = { ...source, resultId: ulid(), rows: [{ metric: "Gross takings", aug: 43193.54, jul: 44520.09 }, { metric: "Gross margin", aug: 54.3, jul: 62.6 }, { metric: "Net profit", aug: 5607.61, jul: 441.65 }],
    rowFormats: [{ type: "currency" as const, currency: "AUD" }, { type: "percent" as const, percentScale: "percent" as const }, { type: "currency" as const, currency: "AUD" }] };
  const plain = text(compose(scorecard, { markdown: "August was mixed.\n\n{{t}}", tables: [{ id: "t", resultId: scorecard.resultId, columnKeys: ["metric", "aug", "jul"], headers: null, limit: 10 }] }));
  assert.doesNotMatch(plain, /\*\*/u);
  assert.match(plain, /\| Gross margin \| 54\.3% \| 62\.6% \|\n\| Net profit \| \$5,608 \| \$442 \|/u);
});

test("a single row of measures is stood on its end instead of read sideways", () => {
  const amount = (key: string, label: string): TraceTableColumn => ({ key, label, type: "currency", currency: "AUD" });
  const source = evidence([{ key: "pnl_period", label: "Period", type: "date" }, amount("rev", "Sales revenue"), amount("cos", "Cost of sales"), amount("gp", "Gross profit"), amount("opex", "Operating expenses"), amount("np", "Net profit")],
    [{ pnl_period: "2026-08-01T00:00:00.000", rev: 41768.97, cos: 19997.39, gp: 21771.58, opex: 16163.97, np: 5607.61 }], semantics(["pnl.period.month"]));
  const result = compose(source, { markdown: "August made money.\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["pnl_period", "rev", "cos", "gp", "opex", "np"], headers: null, limit: 5 }] });
  assert.equal(text(result), [
    "August made money.", "",
    "| Line | Aug 2026 |", "| --- | ---: |",
    "| Sales revenue | $41,769 |", "| Cost of sales | $19,997 |", "| **Gross profit** | **$21,772** |", "| Operating expenses | $16,164 |", "| **Net profit** | **$5,608** |",
  ].join("\n"));
  // Every cell is still a bound claim; only the layout changed.
  assert.equal(result.ok && result.answer.claims.length, 6);
  // Two columns are already a sentence-sized table and stay as they are.
  const pair = evidence([{ key: "who", label: "Salesperson", type: "string" }, money], [{ who: "Jack", sales: 10600 }]);
  assert.match(text(compose(pair, { markdown: "Top seller:\n\n{{t}}", tables: [{ id: "t", resultId: pair.resultId, columnKeys: ["who", "sales"], limit: 5 }] })), /\| Salesperson \| Gross takings \\\(inc tax\\\) \|\n\| --- \| ---: \|\n\| Jack \| \$10,600 \|/u);
});

test("a period bucket is named as its period, not as the day it starts", () => {
  const period: TraceTableColumn = { key: "sales_completed_at", label: "Completed at (business date)", type: "date" };
  const table = (grain: string, rows: string[], today = options.today) => {
    const source = evidence([period, money], rows.map((day) => ({ sales_completed_at: `${day}T00:00:00.000`, sales: 1200 })), semantics([`sales.completed_at.${grain}`]));
    return text(compose(source, { markdown: "Trend:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["sales_completed_at", "sales"], headers: ["Period", "Sales"], limit: 10 }] }, { today }));
  };
  assert.match(table("month", ["2026-07-01", "2026-08-01"]), /\| Jul 2026 \| \$1,200 \|\n\| Aug 2026 \|/u);
  assert.match(table("week", ["2026-07-06", "2026-07-13"]), /\| 6 Jul \| \$1,200 \|\n\| 13 Jul \|/u);
  assert.match(table("day", ["2026-09-12", "2026-09-14"]), /\| Sat 12 Sep \| \$1,200 \|\n\| Mon 14 Sep \|/u);
  assert.match(table("quarter", ["2026-04-01", "2026-07-01"]), /\| Q2 2026 \|/u);
  // A week from another year says which year.
  assert.match(table("week", ["2025-12-29", "2026-01-05"]), /\| 29 Dec 2025 \| \$1,200 \|\n\| 5 Jan \|/u);
});

test("an ordinary date column keeps its full calendar date", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, { key: "last_sold", label: "Last sold", type: "date" }], [{ item: "Felt Breed 30", last_sold: "2025-11-03" }, { item: "Neo 20", last_sold: "2026-02-17" }]);
  assert.match(text(compose(source, { markdown: "Stale lines:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "last_sold"], limit: 10 }] })), /\| Felt Breed 30 \| 3 Nov 2025 \|/u);
});

test("pivot period headings name months, and a model-written header cannot rename them", () => {
  const source = evidence([
    { key: "metric", label: "Metric", type: "string" },
    { key: "p_2026_07_01", label: "1 July 2026", type: "number" },
    { key: "p_2026_08_01", label: "1 Aug 2026", type: "number" },
  ], [{ metric: "Sales revenue", p_2026_07_01: 42016.69, p_2026_08_01: 41768.97 }, { metric: "Net margin", p_2026_07_01: 1.05, p_2026_08_01: 13.43 }],
  semantics(["metric"], "complete", { inputGrains: [["xero_pnl.period.month"]] }),
  { rowFormats: [{ type: "currency", currency: "AUD" }, { type: "percent", percentScale: "percent" }] });
  const answer = text(compose(source, { markdown: "P&L:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["metric", "p_2026_07_01", "p_2026_08_01"], headers: ["Line", "August", "July"], limit: 10 }] }));
  assert.match(answer, /\| Line \| Jul 2026 \| Aug 2026 \|/u);
  assert.match(answer, /\| Sales revenue \| \$42,017 \| \$41,769 \|/u);
  assert.match(answer, /\| Net margin \| 1\.1% \| 13\.4% \|/u);
});

test("headers are short names: the right count, and never a figure of their own", () => {
  const source = evidence([{ key: "item", label: "Item name", type: "string" }, { key: "units", label: "Units sold (last 365 days)", type: "number" }], [{ item: "Tube", units: 210 }]);
  const table = (headers: string[] | null) => compose(source, { markdown: "Units:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "units"], headers, limit: 5 }] });
  assert.match(text(table(["Product", "Units (365d)"])), /\| Product \| Units \\\(365d\\\) \|/u);
  assert.match(text(table(null)), /\| Item name \| Units sold \\\(last 365 days\\\) \|/u);
  for (const [headers, reason] of [[["Product"], /one header per column/u], [["Product", "Units (90d)"], /states a figure/u]] as const) {
    const result = table([...headers]);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.issues.join(" "), reason);
  }
});

test("a symbol typed beside a placeholder is not shown twice", () => {
  const source = evidence([money, { key: "change", label: "Change", type: "percent", percentScale: "percent" }, { key: "delta", label: "Delta", type: "currency", currency: "AUD" }], [{ sales: 9126.74, change: 26.8, delta: -1981.03 }]);
  assert.equal(text(compose(source, { markdown: "Sales were **${{sales}} including GST**, up {{change}}%, a move of -{{delta}}.", values: [value(source, "sales", "sales"), value(source, "change", "change"), value(source, "delta", "delta")] })),
    "Sales were **$9,127 including GST**, up 26.8%, a move of -$1,981.");
});

test("direction said in words is not said again by a minus sign", () => {
  const source = evidence([{ key: "change", label: "Change", type: "percent", percentScale: "percent" }, { key: "profit", label: "Net profit", type: "currency", currency: "AUD" }], [{ change: -19.9, profit: -512.4 }]);
  const values = [value(source, "c", "change"), value(source, "p", "profit")];
  assert.equal(text(compose(source, { markdown: "Sales are **down {{c}}** on last year, and profit came in at {{p}}.", values })),
    "Sales are **down 19.9%** on last year, and profit came in at -$512.40.");
  assert.equal(text(compose(source, { markdown: "September is below last year’s pace by {{c}} year on year.", values: [values[0]!] })),
    "September is below last year’s pace by 19.9% year on year.");
  // A rise that is really a fall keeps its minus: the sign is the only thing telling the truth.
  assert.equal(text(compose(source, { markdown: "Sales rose by {{c}}.", values: [values[0]!] })), "Sales rose by -19.9%.");
  // "fell from" introduces a level, and a level can genuinely be negative.
  assert.equal(text(compose(source, { markdown: "A drop of {{c}}: profit fell from {{p}}.", values })), "A drop of 19.9%: profit fell from -$512.40.");
});

test("caveats are one footnote, said once, and never cost the answer its state", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, money], Array.from({ length: 12 }, (_, index) => ({ item: `Bike ${index}`, sales: 5000 - index })), semantics(["item"], "limited"));
  const result = compose(source, {
    markdown: "Clear the stale bikes first. Stock is valued at cost excluding GST.\n\n{{t}}",
    tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Bike", "Cost"], limit: 5 }],
    limitations: ["Stock is valued at cost, excluding GST.", "List prices are Lightspeed's current defaults.", "List prices are the current Lightspeed defaults."],
  });
  const answer = text(result);
  const notes = answer.split("\n\n").filter((paragraph) => paragraph.startsWith(ANSWER_NOTE_PREFIX));
  assert.equal(notes.length, 1, "exactly one footnote paragraph");
  assert.equal(answer.split("\n\n").at(-1), notes[0], "the footnote closes the answer");
  // Said in the body already, and said twice in limitations: each survives once.
  assert.doesNotMatch(notes[0]!, /cost/iu);
  assert.equal((notes[0]!.match(/current/giu) ?? []).length, 1);
  // The result itself is capped, so the note cannot give a total.
  assert.match(notes[0]!, /The table shows the first 5 rows, not every row\./u);
  assert.doesNotMatch(answer, /does not establish a total for the full population/u);
  assert.equal(result.ok && result.answer.state, "Qualified");

  // Asking for a top ten and getting ten rows needs no note, but limited evidence is still Qualified.
  const topTen = compose(source, { markdown: "Your top ten:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], limit: 10 }] }, { question: "What were my top 10 products?" });
  assert.doesNotMatch(text(topTen), /Note:/u);
  assert.equal(topTen.ok && topTen.answer.state, "Qualified");
});

test("source-system codes read as labels, and an italic aside joins the footnote", () => {
  const source = evidence([{ key: "account", label: "Account", type: "string" }, { key: "kind", label: "Account class", type: "string" }, money],
    [{ account: "Purchases", kind: "COST_OF_SALES", sales: 17833 }, { account: "SRAM parts", kind: "OPERATING_EXPENSE", sales: 299 }]);
  const result = compose(source, {
    markdown: "Purchases led at {{top}}.\n\n{{t}}\n\n*Deputy wage cost excludes superannuation and other on-costs.*",
    values: [value(source, "top", "sales", 0, "compact")],
    tables: [{ id: "t", resultId: source.resultId, columnKeys: ["account", "kind", "sales"], headers: ["Account", "Type", "August"], limit: 10 }],
    limitations: ["Accrual basis."],
  });
  const answer = text(result);
  assert.match(answer, /\| Purchases \| Cost of sales \| \$17,833 \|\n\| SRAM parts \| Operating expense \| \$299 \|/u);
  assert.ok(answer.endsWith(`${ANSWER_NOTE_PREFIX}Deputy wage cost excludes superannuation and other on-costs. Accrual basis.`), answer);
  assert.doesNotMatch(answer, /\*Deputy/u);
});

test("only the headline figure stays bold", () => {
  const source = evidence([money, { key: "tx", label: "Transactions", type: "number" }], [{ sales: 19435.48, tx: 63 }]);
  const answer = text(compose(source, {
    markdown: "Sales were **{{sales}}** from **{{tx}} transactions**, a **strong** week.\n\n- **Busy Saturday**: most of the lift.\n- **{{again}} takings** held up.",
    values: [value(source, "sales", "sales"), value(source, "tx", "tx"), value(source, "again", "sales", 0, "compact")],
  }));
  assert.equal(answer, "Sales were **$19,435** from 63 transactions, a **strong** week.\n\n- **Busy Saturday**: most of the lift.\n- **$19.4k takings** held up.");
});

test("a statement's bolded total rows are left alone", () => {
  const source = evidence([{ key: "line", label: "Line", type: "string" }, money], [{ line: "Sales revenue", sales: 42016.69 }]);
  const answer = text(compose(source, { markdown: "Profit was **{{s}}**.\n\n| Line | July |\n|---|---:|\n| **Gross profit** | **{{g}}** |", values: [value(source, "s", "sales"), value(source, "g", "sales")] }));
  assert.match(answer, /\| \*\*Gross profit\*\* \| \*\*\$42,017\*\* \|/u);
});

test("a day the evidence spans can be named even though it has no row", () => {
  const day: TraceTableColumn = { key: "sales_completed_at", label: "Completed at", type: "date" };
  const source = evidence([day, money], ["2026-09-11", "2026-09-12", "2026-09-14"].map((date) => ({ sales_completed_at: `${date}T00:00:00.000`, sales: 1400 })), semantics(["sales.completed_at.day"]));
  const closed = (markdown: string) => compose(source, { markdown, values: [value(source, "next", "sales", 2)] }, { question: "when was the store last closed - best guess" });
  assert.equal(text(closed("Best guess: **Sunday 13 September**. Trading resumed the next day with {{next}}.")),
    "Best guess: **Sunday 13 September**. Trading resumed the next day with $1,400.");
  // Outside the evidence it is still an unbound figure, and a wrong weekday is caught.
  const outside = closed("Best guess: 2 August. Trading resumed with {{next}}.");
  assert.match(outside.ok ? "" : outside.issues.join(" "), /Unbound figures: 2/u);
  const wrongDay = closed("Best guess: Saturday 13 September. Trading resumed with {{next}}.");
  assert.match(wrongDay.ok ? "" : wrongDay.issues.join(" "), /13 September 2026 is a Sunday, not a Saturday/u);
});

test("window lengths from governed fields, in-span date ranges and the article \"one\" are not figures", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, { key: "inventory_units_sold_365d", label: "Units sold (last 365 days)", type: "number" }, { key: "day", label: "Day", type: "date" }],
    [{ item: "Tube", inventory_units_sold_365d: 210, day: "2026-09-01" }, { item: "Tyre", inventory_units_sold_365d: 90, day: "2026-09-19" }]);
  const values = [value(source, "units", "inventory_units_sold_365d")];
  assert.equal(text(compose(source, { markdown: "Over 1–19 September the one line to watch sold {{units}} in the last 365 days.", values })),
    "Over 1–19 September the one line to watch sold 210 in the last 365 days.");
  // A window no cited field carries, a count in words, and a range past the evidence are still figures.
  for (const [markdown, figure] of [["It sold {{units}} in 45 days.", /45/u], ["Two lines sold {{units}}.", /Two/u], ["Over 1–25 September it sold {{units}}.", /25/u], ["It sold {{units}}, about one hundred a month.", /one hundred/u]] as const) {
    const result = compose(source, { markdown, values });
    assert.match(result.ok ? "" : result.issues.join(" "), figure, markdown);
  }
});

test("a table's own row count and a window the governed query set are scope", () => {
  const source = { ...evidence([{ key: "item", label: "Item", type: "string" }, money], Array.from({ length: 8 }, (_, index) => ({ item: `Bike ${index}`, sales: 6000 - index }))), queryYaml: "filters:\n  - member: inventory.days_since_last_sale\n    operator: gte\n    values: ['90']" } as AnswerEvidence;
  const tables = [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Bike", "Cost"], limit: 8 }];
  assert.match(text(compose(source, { markdown: "These eight bikes are a one-off clearance: no sale in 90 days.\n\n{{t}}", tables })), /^These eight bikes are a one-off clearance: no sale in 90 days\./u);
  for (const [markdown, figure] of [["These nine bikes have not sold.\n\n{{t}}", /nine/u], ["No sale in 30 days.\n\n{{t}}", /30/u], ["Twenty-one bikes have not sold.\n\n{{t}}", /Twenty-one/u]] as const) {
    const result = compose(source, { markdown, tables });
    assert.match(result.ok ? "" : result.issues.join(" "), figure, markdown);
  }
});

test("scoped dates never launder an amount that merely sits beside a month", () => {
  const stripped = stripScopedCalendarDates("We took $13 September-on-September, and closed on 13 Sept 2026 and Sept 13.", [["2026-09-01", "2026-09-18"]]);
  assert.match(stripped.text, /\$13 September-on-September/u);
  assert.doesNotMatch(stripped.text, /13 Sept 2026|Sept 13/u);
  assert.equal(stripPasses("closed on 31 September", [["2026-09-01", "2026-09-30"]]), false, "an impossible date is not a date");
  assert.equal(stripPasses("closed on 13 September 2025", [["2026-09-01", "2026-09-18"]]), false, "a named year outside the span stays");
});
function stripPasses(value: string, spans: [string, string][]): boolean {
  return !/\d/u.test(stripScopedCalendarDates(value, spans).text);
}

test("the footnote is marked for the renderer and the body is not", () => {
  const html = renderAssistantMarkdown(`Sales were **$19,435**.\n\n${ANSWER_NOTE_PREFIX}Takings include GST.`);
  assert.equal(html, '<p>Sales were <strong>$19,435</strong>.</p><p class="answerNote">Note: Takings include GST.</p>');
});

test("the chat contract asks for short answers and tells the model how the composer renders", () => {
  const instructions = renderOmniInstructions({ topicIndex: "- sales_analytics", topicCount: 1, timezone: "Australia/Melbourne", currency: "AUD", todayLine: options.today, activeConnectors: ["lightspeed"], freshnessLines: "" });
  for (const rule of [/under 50 words/u, /Under 110 words of prose/u, /Under 230 words of prose and at most two tables/u, /What never appears in the body/u, /The same fact twice/u, /That is the only bold figure in the answer/u, /At most 5 columns/u, /Match the owner's register/u]) assert.match(instructions, rule);
  for (const retired of [/There is no length limit/u, /Structure generously/u, /Several hundred words is right here/u, /full formatting toolkit/u]) assert.doesNotMatch(instructions, retired);
  for (const rule of [/never "\$\{\{sales\}\}" or "\{\{change\}\}%"/u, /headers is one short, plain header per column key/u, /single footnote/u, /Calendar dates are not figures/u, /Never spell a date out in words/u]) assert.match(COMPOSE_ANSWER_INSTRUCTIONS, rule);
});

test("a pivot's change reads signed, in points on a rate, and a week heading says it is a week", () => {
  const source = evidence([
    { key: "metric", label: "Metric", type: "string" },
    { key: "w1", label: "7 Sep 2026", type: "number" },
    { key: "w2", label: "14 Sep 2026", type: "number" },
    { key: "change", label: "Change", type: "percent", percentScale: "percent" },
  ], [
    { metric: "Gross takings", w1: 18000, w2: 20232.5, change: 12.4027 },
    { metric: "Gross margin", w1: 58.2, w2: 55.1, change: -3.1 },
    { metric: "Transactions", w1: 80, w2: 80, change: 0 },
  ], semantics(["metric"]), { rowFormats: [{ type: "currency", currency: "AUD" }, { type: "percent", percentScale: "percent" }, { type: "number" }] });
  const answer = text(compose(source, { markdown: "Takings rose.\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["metric", "w1", "w2", "change"], headers: null, limit: 10 }] }));
  assert.match(answer, /\| Metric \| Week of 7 Sep \| Week of 14 Sep \| Change \|/u);
  assert.match(answer, /\| Gross takings \| \$18,000 \| \$20,233 \| \+12\.4% \|/u);
  assert.match(answer, /\| Gross margin \| 58\.2% \| 55\.1% \| -3\.1 pts \|/u);
  assert.match(answer, /\| Transactions \| 80 \| 80 \| 0\.0% \|/u);
});

test("an em dash never reaches the owner, in the body or the footnote", () => {
  const source = evidence([money], [{ sales: 19435.48 }]);
  const answer = text(compose(source, {
    markdown: "Sales were {{s}} — a solid week.\n\n- Workshop — steady",
    values: [value(source, "s", "sales")],
    limitations: ["Deputy — wage cost excludes super."],
  }));
  assert.doesNotMatch(answer, /—/u);
  assert.match(answer, /^Sales were \$19,435, a solid week\./u);
  assert.match(answer, /\n- Workshop, steady\n/u);
  assert.ok(answer.endsWith(`${ANSWER_NOTE_PREFIX}Deputy, wage cost excludes super.`), answer);
  // A line with no em dash is left exactly as written, trailing comma and all.
  assert.match(text(compose(source, { markdown: "Sales were {{s}},\nabout as expected.", values: [value(source, "s", "sales")] })), /^Sales were \$19,435,\nabout as expected\.$/u);
});

test("an empty cell is blank, an empty label says so, and a figure is never cited from one", () => {
  const source = evidence([{ key: "brand", label: "Brand", type: "string" }, money], [{ brand: null, sales: 1200 }, { brand: "**Giant**", sales: null }]);
  assert.match(text(compose(source, { markdown: "By brand:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["brand", "sales"], headers: ["Brand", "Sales"], limit: 10 }] })),
    /\| Not set \| \$1,200 \|\n\| Giant \| \|$/u);
  const cited = compose(source, { markdown: "Giant sold {{g}}.", values: [value(source, "g", "sales", 1)] });
  assert.equal(cited.ok, false);
  assert.match(cited.ok ? "" : cited.issues.join(" "), /empty cell/u);
});

test("a table cut short from a complete result says how many rows it shows", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, money], Array.from({ length: 12 }, (_, index) => ({ item: `Bike ${index}`, sales: 5000 - index })), semantics(["item"]));
  const answer = text(compose(source, { markdown: "Stock to clear:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Bike", "Cost"], limit: 5 }] }));
  assert.ok(answer.endsWith(`${ANSWER_NOTE_PREFIX}The table shows 5 of 12 rows.`), answer);
});

test("a pivot's change cited in a sentence keeps its own unit, never its row's money format", () => {
  const source = evidence([
    { key: "metric", label: "Metric", type: "string" },
    { key: "aug", label: "1 Aug 2026", type: "number" },
    { key: "sep", label: "1 Sep 2026", type: "number" },
    { key: "change", label: "Change", type: "percent", percentScale: "percent" },
  ], [
    { metric: "Takings", aug: 16737, sep: 22190, change: 32.58 },
    { metric: "Gross margin", aug: 65.9, sep: 62.4, change: -3.5 },
    { metric: "Average sale", aug: 110.84, sep: 95.65, change: -13.7 },
  ], semantics(["metric"]), { rowFormats: [{ type: "currency", currency: "AUD" }, { type: "percent", percentScale: "percent" }, { type: "currency", currency: "AUD" }] });
  const answer = text(compose(source, {
    markdown: "Takings are {{t}}, up {{tc}}; margin is down {{mc}} and the average sale fell {{ac}}. Margin moved {{mc_again}} percentage points.",
    values: [value(source, "t", "sep", 0, "compact"), value(source, "tc", "change", 0), value(source, "mc", "change", 1), value(source, "ac", "change", 2), value(source, "mc_again", "change", 1)],
  }));
  assert.equal(answer, "Takings are $22.2k, up 32.6%; margin is down 3.5 pts and the average sale fell 13.7%. Margin moved -3.5 percentage points.");
});

test("a derived percent change reads signed in a table, and its blank-cell note appears only with a blank on show", () => {
  const source = evidence([
    { key: "category", label: "Category", type: "string" },
    { key: "sep", label: "September", type: "currency", currency: "AUD" },
    { key: "aug", label: "August", type: "currency", currency: "AUD" },
    { key: "change", label: "Change", type: "percent", percentScale: "percent" },
  ], [
    { category: "Services", sep: 7137, aug: 3475, change: 105.38 },
    { category: "Kids bikes", sep: 660, aug: 1319, change: -49.96 },
    { category: "Brakes", sep: 1170, aug: 1170, change: 0 },
    { category: "Gravel bikes", sep: 900, aug: 0, change: null },
  ], semantics(["category"], "complete", { qualifications: ["A blank calculated figure had a missing or zero value to work from."] }));
  const withCalc = { ...source, provenance: { ...source.provenance, calculations: [{ column: "change", formula: "(sep − aug) ÷ aug × 100", operator: "percent_change" as const }] } };
  const table = (limit: number) => text(compose(withCalc, { markdown: "Services led.\n\n{{t}}", tables: [{ id: "t", resultId: withCalc.resultId, columnKeys: ["category", "sep", "aug", "change"], headers: ["Category", "September", "August", "Change"], limit }] }));
  const full = table(4);
  assert.match(full, /\| Services \| \$7,137 \| \$3,475 \| \+105\.4% \|/u);
  assert.match(full, /\| Kids bikes \| \$660 \| \$1,319 \| -50\.0% \|/u);
  assert.match(full, /\| Brakes \| \$1,170 \| \$1,170 \| 0\.0% \|/u);
  assert.match(full, /Note: A blank calculated figure had a missing or zero value to work from\./u);
  // The blank row is cut from view, so its note goes with it.
  assert.doesNotMatch(table(3), /blank calculated/u);
  // An answer that already explains its blanks is not told twice.
  const explained = text(compose(withCalc, { markdown: "Services led.\n\n{{t}}", limitations: ["A blank change means no August sales."], tables: [{ id: "t", resultId: withCalc.resultId, columnKeys: ["category", "sep", "aug", "change"], headers: ["Category", "September", "August", "Change"], limit: 4 }] }));
  assert.match(explained, /A blank change means no August sales\./u);
  assert.doesNotMatch(explained, /blank calculated/u);
});

test("a timestamp on the store's clock reads as its calendar day", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, { key: "last_sold", label: "Last sold", type: "datetime" }],
    [{ item: "Apollo Trail D 20", last_sold: "2024-01-16T17:39:16.000" }, { item: "Izalco Max", last_sold: null }]);
  assert.match(text(compose(source, { markdown: "Stale stock:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "last_sold"], headers: ["Product", "Last sold"], limit: 5 }] })),
    /\| Apollo Trail D 20 \| 16 Jan 2024 \|\n\| Izalco Max \| \|$/u);
});

test("a single-unit pivot with a change keeps one precision down each column", () => {
  const currency = { type: "currency" as const, currency: "AUD" };
  const source = evidence([
    { key: "metric", label: "Metric", type: "string" },
    { key: "sep", label: "1 Sep 2026", type: "currency", currency: "AUD" },
    { key: "aug", label: "1 Aug 2026", type: "currency", currency: "AUD" },
    { key: "change", label: "Change", type: "percent", percentScale: "percent" },
  ], [
    { metric: "Services", sep: 7137, aug: 3475, change: 105.38 },
    { metric: "Computers", sep: 685, aug: null, change: null },
    { metric: "Helmets", sep: 509.94, aug: 709.93, change: -28.17 },
  ], semantics(["metric"]), { rowFormats: [currency, currency, currency] });
  const answer = text(compose(source, { markdown: "Services led.\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["metric", "sep", "aug", "change"], headers: null, limit: 10 }] }));
  assert.match(answer, /\| Services \| \$7,137 \| \$3,475 \| \+105% \|/u);
  assert.match(answer, /\| Computers \| \$685 \| \| \|/u);
  assert.match(answer, /\| Helmets \| \$510 \| \$710 \| -28\.2% \|/u);
});

test("a table can be ordered by one column before its limit, and each cell still cites its own row", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, { key: "drop", label: "Drop", type: "currency", currency: "AUD" }],
    [{ item: "Tube", drop: -12 }, { item: "Helmet", drop: -710 }, { item: "Tyre", drop: null }, { item: "Bike", drop: -1820 }]);
  const result = compose(source, { markdown: "Biggest falls:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "drop"], headers: ["Product", "Drop"], limit: 3, sort: { columnKey: "drop", direction: "asc" } }] });
  assert.match(text(result), /\| Bike \| -\$1,820 \|\n\| Helmet \| -\$710 \|\n\| Tube \| -\$12 \|/u);
  assert.ok(result.ok && result.answer.claims.some((claim) => claim.refs[0]?.rowIndex === 3 && claim.statement === "Item: Bike"));
  // Blank cells sort last either way.
  assert.match(text(compose(source, { markdown: "Smallest falls:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "drop"], headers: ["Product", "Drop"], limit: 4, sort: { columnKey: "drop", direction: "desc" } }] })), /\| Tube \| -\$12 \|\n\| Helmet \| -\$710 \|\n\| Bike \| -\$1,820 \|\n\| Tyre \| \|/u);
  const unknown = compose(source, { markdown: "Falls:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item"], headers: null, limit: 3, sort: { columnKey: "nope", direction: "asc" } }] });
  assert.equal(unknown.ok, false);
});

test("a header may name a window by its days but never carry a figure", () => {
  const source = evidence([{ key: "item", label: "Item", type: "string" }, money], [{ item: "Bike", sales: 1200 }, { item: "Tube", sales: 12 }]);
  assert.match(text(compose(source, { markdown: "Sales:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Product", "1–19 Sep"], limit: 5 }] })), /\| Product \| 1–19 Sep \|/u);
  assert.equal(compose(source, { markdown: "Sales:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Product", "Sales 1200"], limit: 5 }] }).ok, false);
  // A word that merely starts like a month ("Margin", "Decline") is not a date.
  assert.equal(compose(source, { markdown: "Sales:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Product", "Margin 30"], limit: 5 }] }).ok, false);
  assert.match(text(compose(source, { markdown: "Sales:\n\n{{t}}", tables: [{ id: "t", resultId: source.resultId, columnKeys: ["item", "sales"], headers: ["Product", "Sep to 19"], limit: 5 }] })), /\| Product \| Sep to 19 \|/u);
});

test("a value the prose never places is dropped, an unplaced table is refused, and an unbound figure is shown in its sentence", () => {
  // Production, September 2026: about half of all composition refusals were
  // only "Placeholder {{x}} was defined but not used", each one a full model
  // round trip for a value that could never reach the owner.
  const source = evidence([{ key: "item", label: "Item name", type: "string" }, money], [{ item: "Gear inner wire", sales: 516.98 }, { item: "Brake cable", sales: 237.26 }]);
  const spare = compose(source, { markdown: "Gear wire led with {{wire}}.", values: [value(source, "wire", "sales"), value(source, "cable", "sales", 1)] });
  assert.equal(text(spare), "Gear wire led with $516.98.");
  assert.ok(spare.ok);
  assert.deepEqual(spare.answer.claims.map((claim) => claim.refs[0]?.rowIndex), [0]);
  // A table the model defined but never placed would vanish from the answer, so it is still refused.
  const lostTable = compose(source, { markdown: "Gear wire led with {{wire}}.", values: [value(source, "wire", "sales")], tables: [{ id: "parts", resultId: source.resultId, columnKeys: ["item", "sales"], limit: 5 }] });
  assert.match(lostTable.ok ? "" : lostTable.issues.join(" "), /Table \{\{parts\}\} was defined but not placed/u);
  // The refusal names the sentence, so every figure is repaired in one pass.
  const typed = compose(source, { markdown: "Gear wire led with {{wire}}. Fourteen of the parts kept their price.", values: [value(source, "wire", "sales")] });
  assert.match(typed.ok ? "" : typed.issues.join(" "), /Unbound figures: Fourteen \(in "Fourteen of the parts kept their price\."\)/u);
  assert.match(typed.ok ? "" : typed.issues.join(" "), /Never swap in another count, number word or approximation/u);
});

test("a header may repeat the owner's words or the result's window, and a derived table's input years are in evidence", () => {
  // The owner's workorder question (2026-09-23) lost two composition rounds to
  // "Price 12 months ago" and "Units (12 weeks)", both true to the ask.
  const question = "show me the top 40 items that sell through workorders, then show me current price, current GP margin, and the price of that item 12 months ago";
  const source = evidence([{ key: "item", label: "Item name", type: "string" }, { key: "units", label: "Units sold (net)", type: "number" }, { key: "then", label: "Average shelf price (before discounts)", type: "currency", currency: "AUD" }],
    [{ item: "Gear inner wire", units: 52, then: 9.99 }, { item: "Brake cable", units: 24, then: 9.99 }], semantics(["items"], "complete", { inputWindows: [JSON.stringify({ timezone: "Australia/Melbourne", ranges: [{ dateRange: ["2025-09-01", "2025-09-30"], compareDateRange: null }] })] }),
    { provenance: { sources: [{ connector: "lightspeed", label: "Fixture", dataThrough: "2026-09-18" }], timeRange: { label: "last 12 weeks", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" }, definitions: [], semanticBundleHash: "fixture", identityGraph: { version: 0, hash: "fixture" } } });
  const table = { id: "t", resultId: source.resultId, columnKeys: ["item", "units", "then"], headers: ["Item", "Units (12 weeks)", "Price 12 months ago"], limit: 40 };
  const answer = text(compose(source, { markdown: "Prices held against September 2025.\n\n{{t}}", tables: [table] }, { question }));
  assert.match(answer, /\| Item \| Units \\\(12 weeks\\\) \| Price 12 months ago \|/u);
  // A number neither the owner nor the window carries is still a figure.
  const invented = compose(source, { markdown: "Prices held.\n\n{{t}}", tables: [{ ...table, headers: ["Item", "Units (90 days)", "Price"] }] }, { question });
  assert.match(invented.ok ? "" : invented.issues.join(" "), /states a figure/u);
});

test("a part code a cited label carries is a name, not a figure; a bare number still is", () => {
  // "the SRAM Force XG-1270 cassette" cost the owner's workorder answer a
  // composition round, and the rewrite then bound its margin to the wrong row.
  const source = evidence([{ key: "item", label: "Item name", type: "string" }, { key: "margin", label: "Line gross margin %", type: "percent", percentScale: "percent" }],
    [{ item: "SRAM Force XG-1270 Cassette - 12-Speed, 10-33t, Silver", margin: -2 }, { item: "Shimano SLX M7100 1x12S Groupset", margin: 35.3 }]);
  const named = compose(source, { markdown: "The SRAM Force XG-1270 cassette sold at {{loss}}, while the M7100 groupset held {{slx}}.", values: [value(source, "loss", "margin"), value(source, "slx", "margin", 1)] });
  assert.equal(text(named), "The SRAM Force XG-1270 cassette sold at -2%, while the M7100 groupset held 35.3%.");
  const bare = compose(source, { markdown: "The cassette sold 1270 units at {{loss}}.", values: [value(source, "loss", "margin")] });
  assert.match(bare.ok ? "" : bare.issues.join(" "), /Unbound figures: 1270/u);
});
