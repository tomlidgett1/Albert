import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ModelUsageOutcome } from "../../packages/shared/src/index.js";
import { DurableModelUsageLifecycle } from "../../services/conversation/src/usage-lifecycle.js";
import {
  createSemanticHttpHandler,
  signSemanticHttpRequest,
} from "../../services/semantic-query/src/http.js";
import type { SemanticToolExecutor } from "../../services/semantic-query/src/types.js";

const route = read("app/api/conversation/route.ts");
const migration = read("infra/migrations/control-plane/0024_m6_durable_provider_usage_outcomes.sql");

const usage = Object.freeze({
  providerResponseId: "resp_usage_1",
  providerUsage: Object.freeze({ requests: 1,inputTokens: 100,outputTokens: 20,totalTokens: 120 }),
  metering: Object.freeze({
    rateCardId: "openai-gpt-5.6-au-2026-08-03",
    model: "gpt-5.6-sol" as const,
    fastMode: false,
    requests: 1,
    inputTokens: 100,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 20,
    estimatedCostUsdMicros: 100,
    pricingCompleteness: "aggregate_estimate" as const,
  }),
});

test("an injected artifact-finalizer failure retains provider usage and one failure outcome", async () => {
  const outcomes: ModelUsageOutcome[] = [];
  const lifecycle = new DurableModelUsageLifecycle(async (_checkpoint,outcome) => { outcomes.push(outcome); });
  await lifecycle.providerCompleted(usage);
  await assert.rejects(async () => {
    try {
      throw new Error("injected finalizer failure");
    } catch (error) {
      await lifecycle.terminal("artifact_finalization_failed");
      throw error;
    }
  },/injected finalizer failure/u);
  await lifecycle.terminal("artifact_finalization_failed");
  assert.deepEqual(outcomes,["provider_completed","artifact_finalization_failed"]);
});

test("a post-response abort records completed usage and one disconnect outcome", async () => {
  const outcomes: ModelUsageOutcome[] = [];
  const lifecycle = new DurableModelUsageLifecycle(async (_checkpoint,outcome) => { outcomes.push(outcome); });
  await lifecycle.providerCompleted(usage);
  const stream = new AbortController();
  stream.abort("client_closed_after_provider_response");
  if (stream.signal.aborted) await lifecycle.terminal("client_disconnected");
  await lifecycle.terminal("client_disconnected");
  assert.deepEqual(outcomes,["provider_completed","client_disconnected"]);
});

test("the signed semantic boundary accepts a bounded usage checkpoint", async () => {
  const secret = "usage-checkpoint-contract-secret-at-least-32-bytes";
  const now = Date.parse("2026-08-03T00:00:00.000Z");
  const input = {
    tenantId: "01K40000000000000000000001",
    actorUserId: "51000000-0000-4000-8000-000000000005",
    conversationId: "01K40000000000000000000002",
    turnId: "01K40000000000000000000003",
    providerResponseId: usage.providerResponseId,
    providerUsage: usage.providerUsage,
    metering: usage.metering,
    outcome: "provider_completed" as const,
  };
  let recorded = false;
  const executor = { async execute() { throw new Error("tool route not expected"); } } as SemanticToolExecutor;
  const handler = createSemanticHttpHandler(executor,{
    hmacSecret: secret,
    clock: () => now,
    modelUsageRecorder: { async record(received) {
      recorded = true;
      assert.deepEqual(received,input);
      return {
        meteringDigest: "a".repeat(64),
        providerUsageDigest: "b".repeat(64),
        stage: "provider",
        outcome: "provider_completed",
        idempotentReplay: false,
      };
    } },
  });
  const path = "/v1/model-usage/checkpoint";
  const body = JSON.stringify(input);
  const headers = await signSemanticHttpRequest(path,body,secret,now);
  const response = await handler(new Request(`http://semantic.invalid${path}`,{
    method: "POST",headers:{"content-type":"application/json",...headers},body,
  }));
  assert.equal(response.status,200);
  assert.equal(recorded,true);
});

test("database and route order usage before finalization and bind one terminal outcome", () => {
  assert.ok(route.indexOf("onProviderUsage") < route.indexOf("finalizeAnswerArtifact"));
  assert.match(route,/usageLifecycle\.terminal\("answer_finalized"\)/u);
  assert.match(route,/client_disconnected[\s\S]*turn_timeout[\s\S]*artifact_finalization_failed[\s\S]*runtime_failure/u);
  assert.match(migration,/UNIQUE \(tenant_id,turn_id,stage\)/u);
  assert.match(migration,/provider_replay[\s\S]*terminal_replay/u);
  assert.match(migration,/turn usage was already recorded differently/u);
  assert.match(migration,/a finalized answer cannot receive a failure usage outcome/u);
});

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`,import.meta.url),"utf8");
}
