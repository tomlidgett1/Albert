import assert from "node:assert/strict";
import { test } from "node:test";

import { redactUngroundedProse } from "../../services/conversation/src/grounding.js";
import {
  evidenceCarriesBlockingReason,
  enforceEvidenceBoundAnswerState,
  readableCheckName,
  supersededBlockDisclosure,
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
  assert.match(disclosure, /could not run/u);
  assert.match(disclosure, /deeper history is still backfilling/u);
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
  assert.match(unavailableEvidenceExplanation([blockedAttempt]), /deeper history is still backfilling/u);
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
