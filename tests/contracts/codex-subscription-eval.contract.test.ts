import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CODEX_300_EXTRA_IDS,
  CODEX_300_QUESTIONS,
} from "../../scripts/albert-eval/questions-codex-300.js";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("subscription corpus is an exact, stable 300-turn cross-pattern battery", () => {
  assert.equal(CODEX_300_QUESTIONS.length, 300);
  assert.equal(CODEX_300_EXTRA_IDS.length, 21);
  assert.equal(new Set(CODEX_300_QUESTIONS.map((question) => question.id)).size, 300);
  assert.ok(CODEX_300_QUESTIONS.some((question) => question.pattern === "followup"));
  assert.ok(CODEX_300_QUESTIONS.some((question) => question.pattern === "chart_reformat"));
  assert.ok(CODEX_300_QUESTIONS.some((question) => question.pattern === "drilldown"));
  assert.ok(CODEX_300_QUESTIONS.some((question) => question.tier === "goal"));
  assert.ok(CODEX_300_QUESTIONS.some((question) => question.tier === "theory"));
});

test("subscription runner refuses API auth and locks Luna Max Fast", async () => {
  const [runner, semanticRuntime, packageJson] = await Promise.all([
    read("scripts/albert-eval/run-codex.mts"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
    read("package.json"),
  ]);
  assert.match(runner, /subscription300 requires --auth chatgpt --model gpt-5\.6-luna --effort max --fast/u);
  assert.match(runner, /payload\.authenticationMode !== args\.authMode/u);
  assert.doesNotMatch(runner, /OPENAI_API_KEY/u);
  assert.match(semanticRuntime, /const apiAuthentication = options\.authentication\.mode === "api"/u);
  assert.match(semanticRuntime, /apiAuthentication[\s\S]*validated\.final\.answer\.length > 2_400/u);
  assert.match(packageJson, /eval:codex:subscription300/u);
  assert.match(packageJson, /eval:codex:subscription-loop/u);
  assert.match(runner, /transport === "in-process"/u);
  assert.match(packageJson, /--concurrency 4 --worker-stagger-ms 2500/u);
  assert.match(runner, /index \* args\.workerStaggerMs/u);
});
