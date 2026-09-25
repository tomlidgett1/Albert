import assert from "node:assert/strict";
import test from "node:test";
import { omniRuntimeServiceUrl } from "../../packages/albert-omni/src/service-client";
import { boundOmniTurnContext } from "../../packages/albert-omni/src/context";

test("local web iteration honors the configured deployed Omni runtime", () => {
  assert.equal(omniRuntimeServiceUrl({ NODE_ENV: "development", CODEX_RUNTIME_SERVICE_URL: " https://runtime.example.test/// " }), "https://runtime.example.test");
  assert.equal(omniRuntimeServiceUrl({ NODE_ENV: "test", CODEX_RUNTIME_SERVICE_URL: "https://runtime.example.test" }), "https://runtime.example.test");
});

test("production requires an explicit runtime and isolated development may opt into loopback", () => {
  assert.equal(omniRuntimeServiceUrl({ NODE_ENV: "production" }), "");
  assert.equal(omniRuntimeServiceUrl({ NODE_ENV: "development", CODEX_RUNTIME_SERVICE_URL: "http://127.0.0.1:8799" }), "http://127.0.0.1:8799");
  assert.equal(omniRuntimeServiceUrl({ NODE_ENV: "test" }), "http://127.0.0.1:8792");
});

test("a first turn does not send an empty extension to strict deployed v1 runtimes", () => {
  const id = "01J00000000000000000000001";
  const turn = boundOmniTurnContext({
    protocolVersion: 1, requestId: id, tenantId: id,
    actorId: "00000000-0000-4000-8000-000000000001", role: "owner",
    conversationId: id, turnId: id, message: "Build a dashboard",
    priorConversation: [], priorResults: [], activeConnectors: [], connectorFreshness: [],
    cubeBearer: "test.test.test", model: "gpt-5.6-luna", effort: "max", fastMode: false,
  });
  assert.equal(Object.hasOwn(turn, "priorResults"), false);
  assert.deepEqual(turn.priorConversation, []);
});

test("completed turns accept additive runtime metadata but reject malformed known fields", async () => {
  const { omniSemanticTurnResultSchema } = await import("../../packages/albert-omni/src/contracts");
  const result = { answerState: "Verified", queriesExecuted: 2, modelRequests: 3, durationMs: 100, futureMetadata: { revision: 2 } };
  const parsed = omniSemanticTurnResultSchema.parse(result);
  assert.equal(Object.hasOwn(parsed, "futureMetadata"), false);
  assert.throws(() => omniSemanticTurnResultSchema.parse({ ...result, queriesExecuted: -1 }));
  assert.throws(() => omniSemanticTurnResultSchema.parse({ ...result, answerState: "made-up" }));
});
