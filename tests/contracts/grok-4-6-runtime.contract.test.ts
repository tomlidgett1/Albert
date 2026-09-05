import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  clampReasoningEffort,
  GROK_REASONING_EFFORTS,
  isXaiModel,
  normalizeAgentPreferences,
  resolveAlbertModelTransport,
  serviceTierForPreferences,
  XAI_API_BASE_URL,
} from "../../packages/shared/src/index.ts";
import { laneModelSettings } from "../../packages/albert-v3/src/engine/lanes.ts";
import { buildOpenAIAgentRunConfig } from "../../packages/agent/src/runtime.ts";

const read = (path) => readFileSync(resolve(path), "utf8");

test("Grok 4.6 stays on the official xAI Responses contract", () => {
  const shared = read("packages/shared/src/agent-runtime.ts");
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  const route = read("app/api/v3-conversation/route.ts");
  const controls = read("app/dash/components/ModelRunControls.tsx");
  const migration = read("infra/migrations/control-plane/0136_m6_grok_4_6_model_allowlist.sql");

  assert.match(shared, /id: "grok-4.6"/u);
  assert.equal(XAI_API_BASE_URL, "https://api.x.ai/v1");
  assert.deepEqual(GROK_REASONING_EFFORTS, ["low", "medium", "high", "xhigh"]);
  assert.equal(isXaiModel("grok-4.6"), true);
  assert.equal(clampReasoningEffort("grok-4.6", "max"), "xhigh");
  assert.equal(clampReasoningEffort("grok-4.6", "none"), "low");
  assert.equal(
    serviceTierForPreferences({
      model: "grok-4.6",
      reasoningEffort: "high",
      fastMode: true,
    }),
    "priority",
  );
  assert.equal(
    serviceTierForPreferences({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      fastMode: true,
    }),
    "fast",
  );
  assert.match(engine, /createAlbertModelProvider/u);
  assert.match(engine, /xaiApiKey/u);
  assert.match(route, /XAI_API_KEY/u);
  assert.match(route, /providerForModel\(preferences\.model\)/u);
  assert.match(route, /replaceTurnId/u);
  assert.match(read("app/dash/page.tsx"), /isXaiModel\(runPreferences\.model\)/u);
  assert.match(controls, /"grok-4.6"/u);
  assert.match(migration, /'grok-4.6'/u);

  const transport = resolveAlbertModelTransport({
    model: "grok-4.6",
    openaiApiKey: "openai-must-not-be-used",
    openaiBaseUrl: "https://au.api.openai.com/v1",
    xaiApiKey: "xai-test",
  });
  assert.equal(transport.provider, "xai");
  assert.equal(transport.baseUrl, "https://api.x.ai/v1");
  assert.equal(transport.apiKey, "xai-test");

  const settings = laneModelSettings(
    normalizeAgentPreferences({
      model: "grok-4.6",
      reasoningEffort: "xhigh",
      fastMode: true,
    }),
    "low",
  );
  assert.equal(settings.store, false);
  assert.deepEqual(settings.reasoning, { effort: "xhigh" });
  assert.deepEqual(settings.providerData, {
    include: ["reasoning.encrypted_content"],
    service_tier: "priority",
  });

  const runConfig = buildOpenAIAgentRunConfig({
    model: "grok-4.6",
    reasoningEffort: "medium",
    fastMode: true,
  });
  assert.equal(runConfig.model, "grok-4.6");
  assert.equal(runConfig.modelSettings.store, false);
  assert.deepEqual(runConfig.modelSettings.reasoning, { effort: "medium" });
  assert.equal(runConfig.modelSettings.providerData.service_tier, "priority");
  assert.deepEqual(runConfig.modelSettings.providerData.include, [
    "reasoning.encrypted_content",
  ]);
  assert.equal("context" in runConfig.modelSettings.reasoning, false);
  assert.equal("mode" in runConfig.modelSettings.reasoning, false);
});
