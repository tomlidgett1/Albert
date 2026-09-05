import assert from "node:assert/strict";
import test from "node:test";
import { signInternalRequest } from "../../packages/security/src/internal-request.ts";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";
import { CodexRuntimeHttpHandler } from "../../services/codex-runtime/src/http.ts";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.ts";

const secret = "q".repeat(48);
const config = {
  port: 0,
  listenHost: "127.0.0.1" as const,
  signingSecret: secret,
  cubeApiUrl: "http://127.0.0.1:1",
  authentication: {
    mode: "api" as const,
    apiKey: "sk-fixture",
    baseUrl: "https://au.api.openai.com/v1",
  },
  maxConcurrentTurns: 1,
  pinnedCliVersion: "0.148.0",
  releaseSha: "test",
  deploymentId: "test",
} as const;

function socialTurn(requestId: string, turnId: string): CodexServiceTurn {
  const tenantId = "01J00000000000000000000061";
  const conversationId = "01J00000000000000000000062";
  return {
    protocolVersion: 1,
    requestId,
    tenantId,
    actorId: "11111111-1111-4111-8111-111111111111",
    role: "owner",
    conversationId,
    turnId,
    // The social fast path answers without the codex binary or Cube, so the
    // queue mechanics can be exercised without heavyweight fixtures.
    message: "hello",
    priorConversation: [],
    priorResults: [],
    activeConnectors: ["lightspeed-r"],
    connectorFreshness: [],
    cubeBearer: signCubeJwt({
      secret: "s".repeat(48),
      expiresInSeconds: 900,
      securityContext: {
        tenant_id: tenantId,
        role: "owner",
        specialist_agent_id: "general",
        specialist_agent_version: 1,
        conversation_id: conversationId,
        turn_id: turnId,
      },
    }),
    model: "gpt-5.6-sol",
    effort: "high",
    fastMode: true,
  };
}

async function signedPost(handler: CodexRuntimeHttpHandler, path: string, body: unknown): Promise<Response> {
  const serialized = JSON.stringify(body);
  const signed = await signInternalRequest({ method: "POST", path, body: serialized, secret });
  return handler.handle(new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    body: serialized,
    headers: { ...signed },
  }));
}

test("a busy runtime queues background jobs instead of failing them", async () => {
  const handler = new CodexRuntimeHttpHandler(config);
  // Simulate a long-running turn holding the only slot.
  (handler as unknown as { activeTurns: number }).activeTurns = 1;

  const queued = await signedPost(handler, "/v1/codex/jobs", socialTurn("01J00000000000000000000063", "01J00000000000000000000064"));
  assert.equal(queued.status, 202);

  // While queued, the owner sees a waiting progress event and no result.
  const firstPoll = await signedPost(handler, "/v1/codex/jobs/01J00000000000000000000063/poll", { cursor: 0 });
  assert.equal(firstPoll.status, 200);
  const firstPayload = await firstPoll.json() as { events: Array<{ type: string; label?: string }>; result?: unknown };
  assert.equal(firstPayload.events[0]?.type, "progress");
  assert.match(String(firstPayload.events[0]?.label), /Waiting for a free analysis slot/u);
  assert.equal(firstPayload.result, undefined);

  // The running turn finishes: the slot frees and the queued job starts.
  (handler as unknown as { activeTurns: number }).activeTurns = 0;
  (handler as unknown as { startNextWaitingJob: () => void }).startNextWaitingJob();

  let result: { answerState?: string } | undefined;
  let cursor = 1;
  for (let attempt = 0; attempt < 40 && !result; attempt += 1) {
    const poll = await signedPost(handler, "/v1/codex/jobs/01J00000000000000000000063/poll", { cursor });
    const payload = await poll.json() as { cursor: number; result?: { answerState?: string } };
    cursor = payload.cursor;
    result = payload.result;
  }
  assert.equal(result?.answerState, "Verified");
});

test("only a full waiting queue is a genuine overload", async () => {
  const handler = new CodexRuntimeHttpHandler(config);
  (handler as unknown as { activeTurns: number }).activeTurns = 1;
  const waiting = (handler as unknown as { waitingJobs: unknown[] }).waitingJobs;
  for (let index = 0; index < 32; index += 1) waiting.push({ job: { abort: new AbortController() }, turn: {} });

  const rejected = await signedPost(handler, "/v1/codex/jobs", socialTurn("01J00000000000000000000065", "01J00000000000000000000066"));
  assert.equal(rejected.status, 429);
  const payload = await rejected.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "codex_overloaded");
});
