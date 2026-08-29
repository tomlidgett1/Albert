import assert from "node:assert/strict";
import test from "node:test";
import { codexAnalyticalBriefSchema } from "../../packages/albert-codex/src/contracts.ts";
import { buildSharedAnalyticalBrief, explicitSubQuestions } from "../../services/conversation/src/analytical-brief.ts";
import { CODEX_HARD100_QUESTIONS } from "../../scripts/albert-eval/questions-codex-hard100.ts";

test("multi-part questions enumerate their sub-questions as brief requirements", () => {
  const brief = buildSharedAnalyticalBrief({
    message: "Take the most overstaffed day you found and tell me what trimming ten hours off it would save per month, and what the risk is.",
    activeConnectors: ["lightspeed", "deputy", "xero"],
    includeGeneric: true,
  });
  assert.ok(brief);
  const facetLines = brief.answerMustCover.filter((line) => line.startsWith("Answer the owner's explicit sub-question"));
  assert.ok(facetLines.length >= 2, JSON.stringify(brief.answerMustCover));
  assert.ok(facetLines.some((line) => /risk/u.test(line)));
  // The abstract generic line is replaced by the concrete list, not stacked.
  assert.ok(!brief.answerMustCover.some((line) => line.startsWith("Answer every explicit sub-question")));
});

test("every hard100 question builds a brief the turn contract accepts", () => {
  for (const question of CODEX_HARD100_QUESTIONS) {
    const brief = buildSharedAnalyticalBrief({
      message: question.question,
      activeConnectors: ["lightspeed", "deputy", "xero"],
      includeGeneric: true,
    });
    assert.ok(brief, question.id);
    const parsed = codexAnalyticalBriefSchema.safeParse(brief);
    assert.ok(parsed.success, `${question.id}: ${parsed.success ? "" : parsed.error.issues[0]?.message}`);
  }
});

test("single-ask questions carry no facet lines", () => {
  assert.equal(explicitSubQuestions("What were my total sales last week?").length, 1);
  const brief = buildSharedAnalyticalBrief({
    message: "What were my total sales last week?",
    activeConnectors: ["lightspeed"],
    includeGeneric: true,
  });
  assert.ok(brief);
  assert.ok(!brief.answerMustCover.some((line) => line.startsWith("Answer the owner's explicit sub-question")));
});
