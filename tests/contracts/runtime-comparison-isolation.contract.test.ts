import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Compare is a client coordinator and neither governed backend depends on it", async () => {
  const [component, v3Route, codexRoute] = await Promise.all([
    read("app/dash/components/runtime-comparison-workspace.tsx"),
    read("app/api/v3-conversation/route.ts"),
    read("app/api/codex-conversation/route.ts"),
  ]);
  assert.match(component, /"\/api\/v3-conversation"/u);
  assert.match(component, /"\/api\/codex-conversation"/u);
  assert.doesNotMatch(v3Route, /runtime-comparison-workspace|RuntimeComparisonWorkspace/u);
  assert.doesNotMatch(codexRoute, /runtime-comparison-workspace|RuntimeComparisonWorkspace/u);
});

test("Compare launches distinct lanes concurrently with one snapshotted fair model profile", async () => {
  const component = await read("app/dash/components/runtime-comparison-workspace.tsx");
  assert.match(component, /model:\s*"gpt-5\.6-luna"[\s\S]*reasoningEffort:\s*"max"[\s\S]*fastMode:\s*true/u);
  assert.match(component, /setPreferences\] = useState<AgentRunPreferences>\(COMPARE_DEFAULT_PREFERENCES\)/u);
  assert.match(component, /preferencesSnapshot = Object\.freeze\(\{ \.\.\.preferences \}\)/u);
  assert.match(component, /preferences:\s*input\.preferences/u);
  assert.match(component, /allowedModelIds=\{COMPARE_MODEL_IDS\}/u);
  assert.match(component, /specialistAgentId:\s*"general"/u);
  assert.match(component, /comparisonMode:\s*true/u);
  assert.match(component, /Promise\.allSettled\(\[/u);
  assert.match(component, /albert:\s*new AbortController\(\)[\s\S]*codex:\s*new AbortController\(\)/u);
  assert.match(component, /expectedRuntime = input\.key === "albert" \? "v3" : "codex"/u);
  assert.match(component, /X-Albert-Model/u);
  assert.match(component, /X-Albert-Specialist-Agent/u);
  assert.match(component, /X-Albert-Analysis-Brief/u);
  assert.match(component, /comparison_brief_mismatch/u);
});

test("Compare fences stale attempts and reports neutral answer timing only", async () => {
  const component = await read("app/dash/components/runtime-comparison-workspace.tsx");
  assert.match(component, /expectedRunId !== activeRunIdRef\.current/u);
  assert.match(component, /event\.type === "answer" \|\| event\.type === "clarification"/u);
  assert.match(component, /runtimeErrored = received\.some\(\(event\) => event\.type === "error"\)[\s\S]*answered \|\| runtimeErrored/u);
  assert.match(component, /Observed answer times/u);
  assert.doesNotMatch(component, /finished .* sooner|faster runtime|winner/iu);
});
