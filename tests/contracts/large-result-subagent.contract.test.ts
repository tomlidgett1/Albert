import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("large governed tables use a separate bounded summarization agent and meter its usage", async () => {
  const source = await readFile("services/conversation/src/live.ts", "utf8");

  assert.match(source, /LARGE_RESULT_ROW_THRESHOLD\s*=\s*100/);
  assert.match(source, /name:\s*"Albert governed result summarizer"/);
  assert.match(source, /reasoning:\s*\{\s*effort:\s*"low",\s*context:\s*"current_turn"\s*\}/);
  assert.match(source, /store:\s*false/);
  assert.match(source, /summarizeLargeResult\(result\)/);
  assert.match(source, /validateEvidenceClaims\([\s\S]*sanitizedSummaryClaims[\s\S]*new Map\(\[\[result\.resultId,result\]\]\)/u);
  assert.match(source, /renderValidatedClaims\(summaryValidation\.claims/);
  assert.match(source, /claims:\s*summaryValidation\.valid\?summaryValidation\.claims:\[\]/);
  assert.match(source, /rows:\s*result\.rows\.slice\(0, 20\)/);
  assert.match(source, /aggregateUsage\.add\(summaryUsage\)/);
  assert.doesNotMatch(source, /summaryAgent[\s\S]{0,300}(?:execute_sql|compiledSql)/i);
});
