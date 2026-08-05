import assert from "node:assert/strict";
import { test } from "node:test";

import { redactUngroundedProse } from "../../services/conversation/src/grounding.js";
import {
  evidenceCarriesBlockingReason,
  enforceEvidenceBoundAnswerState,
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
