import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CODEX_ROUTER_MODEL,
  directCodexConversationReply,
  isClearlyAnalyticalCodexMessage,
  routeCodexMessage,
} from "../../services/conversation/src/codex-router.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("current date and time questions are answered from the trusted tenant clock", () => {
  const now = new Date("2026-08-20T22:20:17.675Z");
  assert.equal(
    directCodexConversationReply("whats todays date", "Australia/Melbourne", now),
    "Today is Friday, 21 August 2026.",
  );
  assert.equal(
    directCodexConversationReply("date tomorrow?", "Australia/Melbourne", now),
    "Tomorrow is Saturday, 22 August 2026.",
  );
  assert.equal(
    directCodexConversationReply("what was yesterday's date?", "Australia/Melbourne", now),
    "Yesterday was Thursday, 20 August 2026.",
  );
  assert.match(
    directCodexConversationReply("what time is it", "Australia/Melbourne", now) ?? "",
    /^It’s 8:20 am AEST on Friday, 21 August 2026\.$/u,
  );
  assert.equal(directCodexConversationReply("what were today's sales", "Australia/Melbourne", now), null);
});

test("obvious business and referential questions bypass the LLM router", () => {
  assert.equal(isClearlyAnalyticalCodexMessage("Show sales this month", false), true);
  assert.equal(isClearlyAnalyticalCodexMessage("Why was that lower?", true), true);
  assert.equal(isClearlyAnalyticalCodexMessage("Break it down", true), true);
  assert.equal(isClearlyAnalyticalCodexMessage("Tell me a joke", false), false);
  assert.equal(isClearlyAnalyticalCodexMessage("Who are you?", false), false);
  assert.equal(isClearlyAnalyticalCodexMessage("Is it raining?", true), false);
});

test("ambiguous normal conversation uses GPT-5 Nano as router and responder", async () => {
  const calls: unknown[] = [];
  const decision = await routeCodexMessage({
    message: "Tell me a short bike joke",
    hasPriorConversation: false,
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    timezone: "Australia/Melbourne",
    safetyIdentifier: "tenant-user-digest",
    client: {
      responses: {
        async create(body: unknown) {
          calls.push(body);
          return {
            output_text: JSON.stringify({
              route: "conversation",
              response: "Why did the bike stop? It was two-tired.",
            }),
          };
        },
      },
    } as never,
  });
  assert.deepEqual(decision, {
    route: "conversation",
    response: "Why did the bike stop? It was two-tired.",
  });
  const body = calls[0] as {
    model: string;
    store: boolean;
    max_output_tokens: number;
    reasoning: { effort: string };
    service_tier: string;
    safety_identifier: string;
    text: { format: { type: string } };
  };
  assert.equal(body.model, CODEX_ROUTER_MODEL);
  assert.equal(body.model, "gpt-5-nano");
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 256);
  assert.equal(body.reasoning.effort, "minimal");
  assert.equal(body.service_tier, "fast");
  assert.equal(body.safety_identifier, "tenant-user-digest");
  assert.equal(body.text.format.type, "json_schema");
});

test("the web route settles direct conversation before acknowledgement or context loading", () => {
  const route = read("app/api/codex-conversation/route.ts");
  const direct = route.indexOf("const directConversationReply = directCodexConversationReply");
  const directReturn = route.indexOf("albert_codex_direct_conversation_answered", direct);
  const router = route.indexOf("const clearlyAnalytical", directReturn);
  const acknowledgement = route.indexOf("const acknowledgementApiKey", router);
  const context = route.indexOf("let priorConversation:", acknowledgement);
  assert.ok(direct >= 0 && direct < directReturn);
  assert.ok(directReturn < router && router < acknowledgement && acknowledgement < context);
  assert.doesNotMatch(route.slice(direct, directReturn), /loadConnectorRouting|signCubeJwt|client\.runTurn/u);
});
