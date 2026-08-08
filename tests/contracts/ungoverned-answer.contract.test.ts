import assert from "node:assert/strict";
import { test } from "node:test";

import { findUngroundedNumbers, redactUngroundedProse } from "../../services/conversation/src/grounding.js";
import {
  answerContainsMarkdownTable,
  answerMentionsResultFigures,
  ensureAnswerCitesResults,
  ensureAnswerIncludesTable,
  ensureAssumptionDisclosed,
  evidenceCarriesBlockingReason,
  enforceEvidenceBoundAnswerState,
  humanisePeriodLabel,
  periodDisclosure,
  periodGroundingValues,
  pickAnswerResult,
  priorAssistantFigures,
  readableCheckName,
  stripOwnerFacingJargon,
  supersededBlockDisclosure,
  synthesizeAnswerFromResults,
  unavailableEvidenceExplanation,
  governedQuerySignature,
  blockedQueryGuidance,
  BLOCKED_QUERY_BUDGET,
} from "../../services/conversation/src/live.js";
import { searchTokens } from "../../services/semantic-query/src/service.js";

/**
 * Regression cover for the turn that asked to compare two workshop service
 * groups across the same month in consecutive years and received a stub. Four
 * independent defects chained; each is pinned separately here.
 */

test("claimless SQL answers may state dataThrough dates without being redacted", () => {
  // Regression: "all time" returned 302 sales, then grounding stripped 7 and
  // 2026 from "through 7 August 2026", leaving only certification waffle.
  const provenance = {
    sources: [{ connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-08-07T09:12:16.609Z" }],
    timeRange: {
      label: "Defined by the statement",
      start: "0001-01-01T00:00:00.000Z",
      end: "2026-08-07T09:12:16.609Z",
      timezone: "Australia/Melbourne",
    },
    definitions: [],
    semanticBundleHash: "x",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  };
  const periodValues = periodGroundingValues([{ provenance }]);
  assert.ok(periodValues.includes(2026));
  assert.ok(periodValues.includes(8));
  assert.ok(periodValues.includes(7));
  const draft = "There were 302 sales transactions across all available history through 7 August 2026.";
  assert.deepEqual(findUngroundedNumbers(draft, [{ total_sales: "302" }], periodValues), []);
  assert.equal(
    periodDisclosure(provenance),
    "Figures from Lightspeed (updated through 7 August 2026).",
  );
});

test("a min/max summary without a table gets the monthly rows appended", () => {
  const result = {
    resultId: "sql:jack-gp",
    columns: [
      { key: "month", label: "Month", type: "string" as const },
      { key: "employee_name", label: "Employee Name", type: "string" as const },
      { key: "gross_profit_ex_gst", label: "Gross Profit Ex Gst", type: "currency" as const },
      { key: "net_sales_ex_gst", label: "Net Sales Ex Gst", type: "currency" as const },
      { key: "cost_used", label: "Cost Used", type: "currency" as const },
      { key: "transactions", label: "Transactions", type: "number" as const },
      { key: "units", label: "Units", type: "number" as const },
    ],
    rows: [
      {
        month: "2024-09-01T00:00:00.000Z",
        employee_name: "Jack Lidgett",
        gross_profit_ex_gst: "8054.7600",
        net_sales_ex_gst: "11978.0100",
        cost_used: "3923.2500",
        transactions: "127",
        units: "427.0000",
      },
      {
        month: "2024-10-01T00:00:00.000Z",
        employee_name: "Jack Lidgett",
        gross_profit_ex_gst: "12947.4600",
        net_sales_ex_gst: "19228.7800",
        cost_used: "6281.3200",
        transactions: "188",
        units: "567.0000",
      },
      {
        month: "2026-08-01T00:00:00.000Z",
        employee_name: "Jack Lidgett",
        gross_profit_ex_gst: "1831.0100",
        net_sales_ex_gst: "2753.3500",
        cost_used: "922.3400",
        transactions: "17",
        units: "58.0000",
      },
    ],
    provenance: {
      sources: [],
      timeRange: {
        label: "Defined by the statement",
        start: "0001-01-01T00:00:00.000Z",
        end: "2026-08-07T00:00:00.000Z",
        timezone: "Australia/Melbourne",
      },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    validations: [],
  };
  const summary =
    "Jack Lidgett’s gross profit was tracked monthly over the 24 months from September 2024 to August 2026, ranging from $1,831.01 to $14,377.22.";
  assert.equal(answerContainsMarkdownTable(summary), false);
  const withTable = ensureAnswerIncludesTable(summary, [result]);
  assert.equal(answerContainsMarkdownTable(withTable), true);
  assert.match(withTable, /September 2024/u);
  assert.match(withTable, /October 2024/u);
  assert.match(withTable, /August 2026/u);
  assert.match(withTable, /\$8,054\.76/u);
  assert.match(withTable, /Gross Profit Ex GST|Gross Profit/u);
  // Constant employee name column is dropped so the series stays readable.
  assert.doesNotMatch(withTable, /^\| Employee Name \|/mu);
  assert.equal(
    ensureAnswerIncludesTable(`${summary}\n\n| Month | GP |\n| --- | --- |\n| September 2024 | $8,054.76 |`, [result]),
    `${summary}\n\n| Month | GP |\n| --- | --- |\n| September 2024 | $8,054.76 |`,
  );
});

test("a redacted draft that lost every result figure synthesises from the table", () => {
  const result = {
    resultId: "r1",
    columns: [{ key: "total_sales", label: "Total Sales", type: "currency" as const }],
    rows: [{ total_sales: "302" }],
    provenance: {
      sources: [],
      timeRange: { label: "x", start: "2026-01-01T00:00:00.000Z", end: "2026-08-07T00:00:00.000Z", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    validations: [],
  };
  const waffle = "The count is exploratory because the sales metric isn’t governed for certification.";
  assert.equal(answerMentionsResultFigures(waffle, [result]), false);
  assert.equal(synthesizeAnswerFromResults([result]), "Total Sales came to $302.00.");
});

test("a method preamble with a populated ranking table is rebuilt from the rows", () => {
  // Regression: "best items sold this week in terms of GP?" returned a 10-row
  // table, then answered with only the GP method and period, no item figures.
  const result = {
    resultId: "r1",
    columns: [
      { key: "item_name", label: "Item Name", type: "string" as const },
      { key: "gross_profit", label: "Gross Profit", type: "currency" as const },
      { key: "units_sold", label: "Units Sold", type: "number" as const },
    ],
    rows: [
      { item_name: "Service - General Service", gross_profit: "709.02000000", units_sold: "6.0000" },
      { item_name: "Schwalbe Marathon Plus", gross_profit: "194.60520000", units_sold: "4.0000" },
    ],
    provenance: {
      sources: [],
      timeRange: {
        label: "2026-08-03 to 2026-08-10",
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-08-10T00:00:00.000Z",
        timezone: "Australia/Melbourne",
      },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    validations: [],
  };
  const preamble =
    "Top items by estimated gross profit this week, based on completed Lightspeed sales. Gross profit is calculated as sales subtotal less average cost multiplied by units sold.";
  assert.equal(answerMentionsResultFigures(preamble, [result]), false);
  const rebuilt = ensureAnswerCitesResults(preamble, [result]);
  assert.match(rebuilt, /Service - General Service/u);
  assert.match(rebuilt, /\$709\.02/u);
  assert.match(rebuilt, /Schwalbe Marathon Plus/u);
  assert.equal(
    ensureAnswerCitesResults("Service - General Service led on GP at $709.02.", [result]),
    "Service - General Service led on GP at $709.02.",
  );
});

test("an unsupported figure costs its own sentence, not the whole answer", () => {
  const narrative = [
    "General Service and Full Service both sell through the workshop.",
    "Together they took 30 bookings in July.",
    "I could not narrow the comparison without knowing which grouping you meant.",
  ].join(" ");
  const survived = redactUngroundedProse(narrative, ["30"]);
  assert.ok(survived.includes("General Service and Full Service"));
  assert.ok(survived.includes("could not narrow the comparison"));
  assert.ok(!survived.includes("30"));
});

test("a table keeps every row a governed cell supports", () => {
  const narrative = [
    "| Product group | July 2026 |",
    "| --- | --- |",
    "| General Service | $12,400 |",
    "| Full Service | $9,900 |",
  ].join("\n");
  const survived = redactUngroundedProse(narrative, ["$9,900"]);
  assert.ok(survived.includes("| General Service | $12,400 |"));
  assert.ok(!survived.includes("$9,900"));
  assert.ok(survived.includes("| --- | --- |"), "the surviving table keeps its rule");
});

test("a table whose every row was unsupported is removed with its header", () => {
  const narrative = [
    "Here is the comparison.",
    "| Product group | July 2026 |",
    "| --- | --- |",
    "| General Service | $12,400 |",
  ].join("\n");
  const survived = redactUngroundedProse(narrative, ["$12,400"]);
  assert.equal(survived, "Here is the comparison.");
});

test("redaction never mistakes a digit inside a larger figure for the blocked one", () => {
  const narrative = "Bookings reached 30. Revenue reached $2,305.";
  const survived = redactUngroundedProse(narrative, ["30"]);
  assert.ok(!survived.includes("Bookings reached 30"));
  assert.ok(survived.includes("$2,305"), "2,305 merely contains the digits 30");
});

test("redaction returns empty only when no part of the narrative survives", () => {
  assert.equal(redactUngroundedProse("Sales were 30.", ["30"]), "");
  assert.equal(redactUngroundedProse("Sales grew.", []), "Sales grew.");
});

test("empty evidence explains nothing, so it may not replace a narrative", () => {
  // The failing turn: no governed query ran, so there was no blocking reason to
  // substitute — yet the model's prose was discarded for a generic apology.
  assert.equal(evidenceCarriesBlockingReason([]), false);
});

test("evidence that names a missing capability may replace a narrative", () => {
  const blocked = [{
    state: "unavailable",
    capabilities: { missing: ["commerce.order_lines.cost"] },
    validation: { status: "failed", warnings: [], checks: [] },
  }] as unknown as Parameters<typeof evidenceCarriesBlockingReason>[0];
  assert.equal(evidenceCarriesBlockingReason(blocked), true);
});

test("a proposed Clarification without ask_user still fails closed to Unavailable", () => {
  // Governance is unchanged: only the narrative survives, never the state.
  assert.equal(enforceEvidenceBoundAnswerState("Clarification", [], false, 3), "Unavailable");
  assert.equal(enforceEvidenceBoundAnswerState("Clarification", [], true, 3), "Clarification");
});

test("value search survives the wording differences that carry no meaning", () => {
  // "Full Services" must reach the catalogue's "Service - Full Service".
  assert.deepEqual(searchTokens("Full Services"), ["full", "service"]);
  assert.deepEqual(searchTokens("e-bikes"), ["bike"]);
  assert.deepEqual(searchTokens("Gen"), ["gen"]);
});

test("value search stays bounded and drops noise tokens", () => {
  assert.equal(searchTokens("a b c d e f g h").length <= 4, true);
  assert.deepEqual(searchTokens("!!! ---"), []);
});

/**
 * Second regression: "how can we improve the profitability of the business"
 * ran three governed queries. The first merchandising attempt was blocked by
 * progressive coverage, the model narrowed the window and re-ran it
 * successfully, and the turn still answered Unavailable — discarding all three
 * tables because the superseded attempt stayed on the evidence record.
 */

const blockedAttempt = {
  state: "unavailable",
  validation: {
    status: "blocked",
    warnings: ["inventory.balances is unavailable before 2026-07-04T04:32:57.328Z; deeper history is still backfilling."],
    checks: [{
      checkId: "progressive_coverage:01KZ54B1PCKM1MHSNHY4XT6DEX:item_shops",
      status: "blocked",
      capability: "inventory.balances",
      coveredFrom: "2026-07-04T04:32:57.328Z",
      coveredTo: "2026-08-04T04:32:57.328Z",
    }],
  },
} as unknown as Parameters<typeof supersededBlockDisclosure>[0][number];

const goodResult = {
  state: "verified",
  validation: { status: "passed", warnings: [], checks: [{ checkId: "result_shape", status: "passed" }] },
} as unknown as typeof blockedAttempt;

test("a recovered retry does not sink the turn that recovered", () => {
  assert.equal(
    enforceEvidenceBoundAnswerState("Qualified", [goodResult, blockedAttempt, goodResult], false, 3),
    "Qualified",
  );
});

test("a block with nothing usable behind it still fails closed", () => {
  assert.equal(enforceEvidenceBoundAnswerState("Qualified", [blockedAttempt], false, 3), "Unavailable");
});

test("a superseded block can never be reported as Verified", () => {
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [goodResult, blockedAttempt], false, 0), "Qualified");
  assert.equal(enforceEvidenceBoundAnswerState("Verified", [goodResult], false, 0), "Verified");
});

test("carrying on past a block discloses what could not run", () => {
  const disclosure = supersededBlockDisclosure([goodResult, blockedAttempt]);
  assert.match(disclosure, /could not be completed/u);
  assert.match(disclosure, /4 July 2026/u);
  assert.match(disclosure, /still loading/u);
  assert.ok(!disclosure.includes("inventory.balances"));
  assert.equal(supersededBlockDisclosure([goodResult]), "");
});

test("an internal connection id never reaches the answer", () => {
  assert.equal(
    readableCheckName("progressive_coverage:01KZ54B1PCKM1MHSNHY4XT6DEX:item_shops"),
    "progressive coverage item shops",
  );
  assert.equal(readableCheckName("cost_coverage"), "cost coverage");
  assert.equal(readableCheckName("01KZ54B1PCKM1MHSNHY4XT6DEX"), "");
  assert.ok(!unavailableEvidenceExplanation([blockedAttempt]).includes("01KZ54B1PCKM1MHSNHY4XT6DEX"));
});

test("a blocked explanation says what the reader can act on", () => {
  const explanation = unavailableEvidenceExplanation([blockedAttempt]);
  assert.match(explanation, /4 July 2026/u);
  assert.match(explanation, /still loading/u);
  assert.ok(!explanation.includes("governed"));
  assert.ok(!explanation.includes("01KZ54B1PCKM1MHSNHY4XT6DEX"));
});


/**
 * Third regression: "go deeper" ran three good sales queries, then hit the
 * progressive-coverage block on merchandising and re-ran the identical query.
 * Nothing refused the repeat, so the turn looped against a query that could
 * never succeed and ended with no answer at all — three tables and silence.
 */

test("the same governed query is one signature however its lists are ordered", () => {
  const a = { topic: "merchandising", metrics: ["composites.gmroi", "composites.stock_to_sales_ratio"], dimensions: ["product.category"] };
  const b = { dimensions: ["product.category"], metrics: ["composites.stock_to_sales_ratio", "composites.gmroi"], topic: "merchandising" };
  assert.equal(governedQuerySignature(a), governedQuerySignature(b));
});

test("a materially different query is a different signature", () => {
  const a = { topic: "merchandising", metrics: ["composites.gmroi"], period: { from: "2026-02-01" } };
  const b = { topic: "merchandising", metrics: ["composites.gmroi"], period: { from: "2026-07-08" } };
  assert.notEqual(governedQuerySignature(a), governedQuerySignature(b));
});

test("a block names the window a retry could actually use", () => {
  const guidance = blockedQueryGuidance(blockedAttempt);
  assert.match(guidance, /only queryable from 2026-07-04 to 2026-08-04/u);
  assert.match(guidance, /Re-run with a period inside that range/u);
  assert.ok(!guidance.includes("01KZ54B1PCKM1MHSNHY4XT6DEX"));
});

test("a block with no coverage window still says what to change", () => {
  const capabilityBlocked = {
    state: "unavailable",
    capabilities: { missing: ["finance.journals"] },
    validation: { status: "blocked", warnings: [], checks: [] },
  } as unknown as typeof blockedAttempt;
  assert.match(blockedQueryGuidance(capabilityBlocked), /It needs journals, which no connected source provides/u);
  const bare = {
    state: "unavailable",
    validation: { status: "blocked", warnings: [], checks: [] },
  } as unknown as typeof blockedAttempt;
  assert.match(blockedQueryGuidance(bare), /before trying again/u);
});

test("the blocked-query budget is small enough to end a turn", () => {
  assert.ok(BLOCKED_QUERY_BUDGET >= 2 && BLOCKED_QUERY_BUDGET <= 6);
});

test("ISO period labels become owner-readable months and weeks", () => {
  assert.equal(
    humanisePeriodLabel({
      label: "2026-08-01 to 2026-09-01",
      start: "2026-08-01T00:00:00.000Z",
      end: "2026-09-01T00:00:00.000Z",
      timezone: "Australia/Melbourne",
    }),
    "August 2026",
  );
  assert.equal(
    humanisePeriodLabel({
      label: "2026-08-03 to 2026-08-10",
      start: "2026-08-03T00:00:00.000Z",
      end: "2026-08-10T00:00:00.000Z",
      timezone: "Australia/Melbourne",
    }),
    "3–9 August 2026",
  );
  assert.equal(
    humanisePeriodLabel({
      label: "Last week",
      start: "2026-08-03T00:00:00.000Z",
      end: "2026-08-10T00:00:00.000Z",
      timezone: "Australia/Melbourne",
    }),
    "Last week",
  );
});

test("ranking synthesis leads with the winner in plain English", () => {
  const result = {
    resultId: "r1",
    columns: [
      { key: "item_name", label: "Item Name", type: "string" as const },
      { key: "gross_profit", label: "Gross Profit", type: "currency" as const },
      { key: "units_sold", label: "Units Sold", type: "number" as const },
    ],
    rows: [
      { item_name: "Service - General Service", gross_profit: "709.02000000", units_sold: "6.0000" },
      { item_name: "Schwalbe Marathon Plus", gross_profit: "194.60520000", units_sold: "4.0000" },
    ],
    provenance: {
      sources: [],
      timeRange: {
        label: "2026-08-03 to 2026-08-10",
        start: "2026-08-03T00:00:00.000Z",
        end: "2026-08-10T00:00:00.000Z",
        timezone: "Australia/Melbourne",
      },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    validations: [],
  };
  const text = synthesizeAnswerFromResults([result]);
  assert.match(text, /led by Service - General Service/u);
  assert.match(text, /\$709\.02/u);
  assert.match(text, /\|/u);
  assert.match(text, /Units Sold/u);
  assert.match(text, /\|\s*6\s*\|/u);
});

test("owner-facing polish strips attestation jargon but keeps the figure", () => {
  const cleaned = stripOwnerFacingJargon(
    "You sold 42 units. This is exploratory because commerce.units_sold could not be attested.",
  );
  assert.match(cleaned, /42 units/u);
  assert.ok(!/attest|commerce\.units_sold|exploratory/iu.test(cleaned));
});

test("server-owned name assumptions are disclosed when the draft omits them", () => {
  const disclosed = ensureAssumptionDisclosed(
    "You sold 42 this month.",
    [{ phrase: "gen services", itemName: "Service - General Service" }],
  );
  assert.match(disclosed, /Treating “gen services” as Service - General Service/u);
  assert.equal(
    ensureAssumptionDisclosed(
      "Treating “gen services” as Service - General Service. You sold 42.",
      [{ phrase: "gen services", itemName: "Service - General Service" }],
    ),
    "Treating “gen services” as Service - General Service. You sold 42.",
  );
});

test("answer synthesis prefers named product rows over a trailing bare row_count", () => {
  // Regression: "what products have no categories" ended on an ls_items
  // source-exploration row_count (17138) and answered "The total is 17138".
  const products = {
    resultId: "sql:products",
    columns: [
      { key: "item_name", label: "Item Name", type: "string" as const },
      { key: "item_id", label: "Item Id", type: "number" as const },
    ],
    rows: [
      { item_name: "Orphan Tube", item_id: "1" },
      { item_name: "Mystery Cable", item_id: "2" },
    ],
    provenance: {
      sources: [],
      timeRange: { label: "x", start: "2026-01-01T00:00:00.000Z", end: "2026-08-07T00:00:00.000Z", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "x",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    validations: [],
  };
  const bareCount = {
    resultId: "source:count",
    columns: [{ key: "row_count", label: "Row Count", type: "number" as const }],
    rows: [{ row_count: "17138" }],
    provenance: products.provenance,
    validations: [],
  };
  assert.equal(pickAnswerResult([products, bareCount])?.resultId, "sql:products");
  const rebuilt = synthesizeAnswerFromResults([products, bareCount]);
  assert.match(rebuilt, /Orphan Tube/u);
  assert.ok(!/17138/u.test(rebuilt));
  // Exploration-only evidence must not become "The total is 17138".
  assert.equal(pickAnswerResult([bareCount]), undefined);
  const explorationOnly = synthesizeAnswerFromResults([bareCount]);
  assert.ok(!/17138/u.test(explorationOnly));
  assert.match(explorationOnly, /couldn't turn the lookups/iu);
});

test("no_fanout blocked guidance tells the model to pin mapping_version", () => {
  const guidance = blockedQueryGuidance({
    state: "unavailable",
    validation: {
      status: "failed",
      checks: [{
        checkId: "no_fanout",
        status: "failed",
        reasonCode: "no_fanout",
        detail: "No Fanout: blocked.",
      }],
      warnings: [],
    },
    capabilities: { missing: [] },
  } as never);
  assert.match(guidance, /mapping_version/iu);
  assert.match(guidance, /claims empty|leave claims/iu);
});

test("format follow-ups may restate figures from the prior assistant answer", () => {
  // Regression: "put in table" after a real answer had no SQL this turn, so
  // grounding stripped $175,672.36 and the state guard said Unavailable.
  const prior = [
    { role: "user", text: "sales this year?" },
    {
      role: "assistant",
      text: "Sales were $175,672.36 from 1 July 2025 through 7 August 2026.",
    },
    { role: "user", text: "put in table" },
  ];
  const figures = priorAssistantFigures(prior);
  assert.ok(figures.includes(175672.36));
  assert.ok(figures.includes(2026));
  assert.ok(figures.includes(2025));
  assert.ok(figures.includes(7));
  assert.ok(figures.includes(1));
  const tableDraft = [
    "| Period | Sales |",
    "| --- | --- |",
    "| 1 July 2025 – 7 August 2026 | $175,672.36 |",
  ].join("\n");
  assert.deepEqual(findUngroundedNumbers(tableDraft, [], figures), []);
  assert.equal(
    enforceEvidenceBoundAnswerState("Exploratory", [], false, 0, true),
    "Exploratory",
  );
  assert.equal(
    enforceEvidenceBoundAnswerState("Exploratory", [], false, 0, false),
    "Unavailable",
  );
});
