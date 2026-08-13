import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  OPENAI_GPT_5_6_RATE_CARD,
  XAI_GROK_4_6_RATE_CARD,
} from "../../packages/usage-metering/src/index.ts";

const read = (path: string) => readFileSync(resolve(path), "utf8");

test("settings usage lists per-query tokens and published API cost", () => {
  const migration = read("infra/migrations/control-plane/0138_m8_model_usage_workspace.sql");
  const route = read("app/api/usage/route.ts");
  const repository = read("services/control-plane/src/web-repository.ts");
  const workspace = read("app/dash/components/UsageWorkspace.tsx");
  const settings = read("app/dash/components/OrganizationWorkspace.tsx");
  const engine = read("packages/albert-v3/src/engine/engine.ts");
  const v3 = read("app/api/v3-conversation/route.ts");

  assert.match(migration, /albert_list_model_usage/u);
  assert.match(migration, /ORDER BY listed\.recorded_at DESC/u);
  assert.match(migration, /inputTokens/u);
  assert.match(migration, /outputTokens/u);
  assert.match(migration, /estimatedCostUsdMicros/u);
  assert.doesNotMatch(migration, /provider_usage/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.albert_list_model_usage\(integer\) TO authenticated/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.albert_record_turn_usage\(text, text, jsonb\) TO authenticated/u);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.albert_list_model_usage\(integer\) FROM PUBLIC, anon, service_role/u);

  assert.match(route, /listModelUsage/u);
  assert.match(repository, /albert_list_model_usage/u);
  assert.match(repository, /PGRST202/u);
  assert.match(workspace, /Input/u);
  assert.match(workspace, /Output/u);
  assert.match(workspace, /Cost/u);
  assert.match(workspace, /formatUsd/u);
  assert.match(settings, /label: "Usage"/u);
  assert.match(settings, /UsageWorkspace/u);

  assert.match(engine, /trackRunnerUsage/u);
  assert.match(engine, /onProviderUsage/u);
  assert.match(v3, /meterOpenAIUsage/u);
  assert.match(v3, /albert_record_turn_usage/u);

  assert.equal(OPENAI_GPT_5_6_RATE_CARD.source, "https://developers.openai.com/api/docs/pricing");
  assert.equal(XAI_GROK_4_6_RATE_CARD.source, "https://docs.x.ai/developers/pricing");
  assert.equal(OPENAI_GPT_5_6_RATE_CARD.models["gpt-5.6-sol"].input, 5_000n);
  assert.equal(OPENAI_GPT_5_6_RATE_CARD.models["gpt-5.6-sol"].output, 30_000n);
  assert.equal(XAI_GROK_4_6_RATE_CARD.models["grok-4.6"].input, 2_000n);
  assert.equal(XAI_GROK_4_6_RATE_CARD.models["grok-4.6"].output, 6_000n);
});
