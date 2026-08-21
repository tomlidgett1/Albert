import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  generateInitialAcknowledgement,
  LOW_LATENCY_ACKNOWLEDGEMENT_MAX_OUTPUT_TOKENS,
  LOW_LATENCY_ACKNOWLEDGEMENT_MODEL,
  LOW_LATENCY_ACKNOWLEDGEMENT_REASONING_EFFORT,
  LOW_LATENCY_ACKNOWLEDGEMENT_SERVICE_TIER,
  LOW_LATENCY_ACKNOWLEDGEMENT_TIMEOUT_MS,
} from "../../services/conversation/src/initial-acknowledgement.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Codex uses GPT-5 Nano minimal Fast for bounded prompt-specific acknowledgement copy", async () => {
  const calls: unknown[] = [];
  const result = await generateInitialAcknowledgement({
    question: "Compare category sales this year with last year and explain the change.",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    safetyIdentifier: "tenant-user-digest",
    model: LOW_LATENCY_ACKNOWLEDGEMENT_MODEL,
    reasoningEffort: LOW_LATENCY_ACKNOWLEDGEMENT_REASONING_EFFORT,
    serviceTier: LOW_LATENCY_ACKNOWLEDGEMENT_SERVICE_TIER,
    timeoutMs: LOW_LATENCY_ACKNOWLEDGEMENT_TIMEOUT_MS,
    maxOutputTokens: LOW_LATENCY_ACKNOWLEDGEMENT_MAX_OUTPUT_TOKENS,
    client: {
      responses: {
        async create(body: unknown) {
          calls.push(body);
          return {
            id: "resp_codex_ack_1",
            service_tier: "priority",
            output_text: JSON.stringify({
              action: "compare",
              focus: "category sales across the requested periods",
            }),
            usage: { input_tokens: 35, output_tokens: 12, total_tokens: 47 },
          };
        },
      },
    } as never,
  });

  assert.equal(
    result?.text,
    "I’ll compare category sales across the requested periods and check what explains the difference.",
  );
  assert.equal(calls.length, 1);
  const body = calls[0] as {
    model: string;
    store: boolean;
    max_output_tokens: number;
    reasoning: { effort: string };
    service_tier: string;
    safety_identifier: string;
    text: { verbosity: string; format: { type: string } };
    input: ReadonlyArray<{ role: string; content: string }>;
  };
  assert.equal(body.model, "gpt-5-nano");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, "minimal");
  assert.equal(body.service_tier, "fast");
  assert.equal(body.max_output_tokens, 128);
  assert.equal(body.safety_identifier, "tenant-user-digest");
  assert.equal(body.text.verbosity, "low");
  assert.equal(body.text.format.type, "json_schema");
  assert.match(body.input.at(-1)?.content ?? "", /category sales this year/u);
});

test("Codex starts every analytical turn concurrently but releases its contextual acknowledgement first", () => {
  const route = read("app/api/codex-conversation/route.ts");
  const acknowledgementStart = route.indexOf("const initialAcknowledgement =");
  const contextStart = route.indexOf("let priorConversation:");
  const runtimeStart = route.indexOf("const runtimeOutcome = client.runTurn");
  const acknowledgementAwait = route.indexOf("const acknowledgement = await initialAcknowledgement", runtimeStart);
  const bufferedDrain = route.indexOf("while (bufferedRuntimeEvents.length > 0)", acknowledgementAwait);
  const runtimeAwait = route.indexOf("const outcome = await runtimeOutcome", bufferedDrain);

  assert.ok(acknowledgementStart >= 0 && acknowledgementStart < contextStart);
  assert.ok(runtimeStart >= 0 && runtimeStart < acknowledgementAwait);
  assert.ok(acknowledgementAwait >= 0 && acknowledgementAwait < bufferedDrain);
  assert.ok(bufferedDrain >= 0 && bufferedDrain < runtimeAwait);
  assert.match(route, /purpose: "acknowledgement"[\s\S]*text: acknowledgement\.text/u);
  assert.match(route, /LOW_LATENCY_ACKNOWLEDGEMENT_MODEL/u);
  assert.match(route, /const acknowledgementApiKey = process\.env\.OPENAI_API_KEY/u);
  assert.doesNotMatch(route, /shouldGenerateInitialAcknowledgement|!parsed\.conversationId/u);
  assert.match(route, /createHash\("sha256"\)[\s\S]*tenant\.tenant_id[\s\S]*auth\.user\.id/u);
  assert.doesNotMatch(route, /I’ll investigate this with Codex through Albert’s governed semantic layer/u);
});
