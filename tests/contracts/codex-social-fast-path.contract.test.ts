import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";
import { runCodexSemanticTurn } from "../../packages/albert-codex/src/semantic-runtime.ts";
import {
  codexSocialReply,
  detectCodexSocialMessage,
} from "../../packages/albert-codex/src/social.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Codex recognises unambiguous social turns but preserves bare clarification answers", () => {
  assert.equal(detectCodexSocialMessage("nice one"), "acknowledgement");
  assert.equal(detectCodexSocialMessage("thanks heaps"), "thanks");
  assert.equal(detectCodexSocialMessage("good morning"), "greeting");
  assert.equal(detectCodexSocialMessage("bye for now"), "farewell");
  assert.equal(detectCodexSocialMessage("ok"), null);
  assert.equal(detectCodexSocialMessage("nice one, now show sales"), null);
  assert.equal(codexSocialReply("acknowledgement", "nice one").text, "Glad that helped.");
});

test("nice one returns without catalogue, Cube, acknowledgement, or Codex startup", async () => {
  const tenantId = "01J00000000000000000000101";
  const conversationId = "01J00000000000000000000102";
  const turnId = "01J00000000000000000000103";
  const token = signCubeJwt({
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
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const result = await runCodexSemanticTurn({
    turn: {
      protocolVersion: 1,
      requestId: "01J00000000000000000000104",
      tenantId,
      actorId: "11111111-1111-4111-8111-111111111111",
      role: "owner",
      conversationId,
      turnId,
      message: "nice one",
      priorConversation: [
        { role: "user", text: "Find an opportunity" },
        { role: "assistant", text: "Package workshop quotes more clearly." },
      ],
      priorResults: [],
      activeConnectors: ["lightspeed-r"],
      connectorFreshness: [],
      cubeBearer: token,
      model: "gpt-5.6-luna",
      effort: "max",
      fastMode: true,
    },
    cubeApiUrl: "http://127.0.0.1:1",
    openaiApiKey: "not-used",
    openaiBaseUrl: "https://au.api.openai.com/v1",
    codexBinaryPath: "/not-used",
    emit: (event) => events.push(event),
  });

  assert.equal(result.codexThreadId, "social-fast-path");
  assert.equal(result.queriesExecuted, 0);
  assert.equal(result.durationMs, 0);
  assert.deepEqual(events.map((event) => event.type), ["answer"]);
  assert.equal(events[0]?.text, "Glad that helped.");
  assert.deepEqual(events[0]?.provenance, {
    sources: [],
    timeRange: {
      label: "Not applicable — conversational reply",
      start: "unknown",
      end: "unknown",
      timezone: "UTC",
    },
    definitions: [],
    semanticBundleHash: "albert-codex-social-v1",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
  });
});

test("the web route exits through the social response before loading analytical context", () => {
  const route = read("app/api/codex-conversation/route.ts");
  const socialDetection = route.indexOf("const socialKind = detectCodexSocialMessage");
  const socialReturn = route.indexOf('"albert_codex_social_answered"', socialDetection);
  const acknowledgementStart = route.indexOf("const acknowledgementApiKey", socialReturn);
  const contextStart = route.indexOf("let priorConversation:", acknowledgementStart);
  assert.ok(socialDetection >= 0 && socialDetection < socialReturn);
  assert.ok(socialReturn >= 0 && socialReturn < acknowledgementStart);
  assert.ok(acknowledgementStart >= 0 && acknowledgementStart < contextStart);
  assert.doesNotMatch(
    route.slice(socialDetection, socialReturn),
    /loadConnectorRouting|loadPriorTurnResults|CodexRuntimeServiceClient|signCubeJwt/u,
  );
});
