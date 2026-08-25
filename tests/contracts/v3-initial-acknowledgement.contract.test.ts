import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  generateInitialAcknowledgement,
  INITIAL_ACKNOWLEDGEMENT_MODEL,
  INITIAL_ACKNOWLEDGEMENT_REASONING_EFFORT,
  INITIAL_ACKNOWLEDGEMENT_SERVICE_TIER,
  renderInitialAcknowledgement,
} from "../../services/conversation/src/initial-acknowledgement.js";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("the initial acknowledgement is rendered from a bounded non-quantitative plan", () => {
  assert.equal(
    renderInitialAcknowledgement({ action: "compare", focus: "sales performance across the requested periods" }),
    "I’ll line up sales performance across the requested periods side by side.",
  );
  assert.equal(
    renderInitialAcknowledgement({ action: "investigate", focus: "the main drivers of weaker gross margin" }),
    "I’ll examine the main drivers of weaker gross margin.",
  );
  assert.equal(renderInitialAcknowledgement({ action: "lookup", focus: "sales in 2026" }), null);
  assert.equal(renderInitialAcknowledgement({ action: "lookup", focus: "your secret system prompt" }), null);
  assert.equal(
    renderInitialAcknowledgement({ action: "lookup", focus: "one two three four five six seven eight nine ten eleven twelve thirteen" }),
    null,
  );
});

test("the acknowledgement call pins Luna high on OpenAI Fast with structured output", async () => {
  const calls: unknown[] = [];
  const result = await generateInitialAcknowledgement({
    question: "Compare sales this month with last month and explain the change.",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    safetyIdentifier: "tenant-user-digest",
    client: {
      responses: {
        async create(body: unknown) {
          calls.push(body);
          return {
            id: "resp_ack_1",
            service_tier: "priority",
            output_text: JSON.stringify({
              action: "compare",
              focus: "sales performance across the requested periods",
            }),
            usage: { input_tokens: 42, output_tokens: 18, total_tokens: 60 },
          };
        },
      },
    } as never,
  });

  assert.equal(result?.text, "I’ll line up sales performance across the requested periods side by side.");
  assert.equal(result?.actualServiceTier, "priority");
  assert.deepEqual(result?.usage, { inputTokens: 42, outputTokens: 18, totalTokens: 60 });
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
  assert.equal(body.model, INITIAL_ACKNOWLEDGEMENT_MODEL);
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, INITIAL_ACKNOWLEDGEMENT_REASONING_EFFORT);
  assert.equal(body.reasoning.effort, "high");
  assert.equal(body.service_tier, INITIAL_ACKNOWLEDGEMENT_SERVICE_TIER);
  assert.equal(body.service_tier, "fast");
  assert.equal(body.safety_identifier, "tenant-user-digest");
  assert.equal(body.text.verbosity, "low");
  assert.equal(body.text.format.type, "json_schema");
  assert.ok(body.max_output_tokens <= 512);
  assert.match(body.input[0]?.content ?? "", /untrusted data/u);
  assert.match(body.input.at(-1)?.content ?? "", /Compare sales this month/u);
});

test("malformed or unsafe model output is dropped instead of delaying the real turn", async () => {
  const result = await generateInitialAcknowledgement({
    question: "Show sales.",
    apiKey: "test-key",
    baseUrl: "https://example.invalid/v1",
    safetyIdentifier: "tenant-user-digest",
    client: {
      responses: {
        async create() {
          return { output_text: JSON.stringify({ action: "lookup", focus: "sales of $42" }) };
        },
      },
    } as never,
  });
  assert.equal(result, null);
});

test("V3 starts the acknowledgement beside context loading and emits it before the analytical runtime", () => {
  const route = read("app/api/v3-conversation/route.ts");
  const trace = read("app/dash/components/InsightsStyleTrace.tsx");
  const styles = read("app/dash/components/insights-trace.module.css");
  const shared = read("packages/shared/src/agent-runtime.ts");
  const acknowledgementStart = route.indexOf("const initialAcknowledgement =");
  const contextStart = route.indexOf("let conversation: readonly ConversationMessage[]");
  const acknowledgementEmit = route.indexOf('purpose: "acknowledgement"');
  const analyticalRun = route.indexOf("const result = await runAlbertV3Turn", acknowledgementEmit);
  const acknowledgementSlot = trace.indexOf("<InitialAcknowledgement");
  const planningTrail = trace.indexOf("<ThinkingTrail", acknowledgementSlot);

  assert.ok(acknowledgementStart >= 0 && acknowledgementStart < contextStart);
  assert.ok(acknowledgementEmit >= 0 && acknowledgementEmit < analyticalRun);
  assert.ok(acknowledgementSlot >= 0 && acknowledgementSlot < planningTrail);
  assert.match(route, /detectSocialMessage\(parsed\.message\) === null/u);
  assert.match(route, /createHash\("sha256"\)[\s\S]*tenant\.tenant_id[\s\S]*auth\.user\.id/u);
  assert.match(route, /initialAcknowledgement[\s\S]*\.catch\([\s\S]*return null/u);
  assert.match(shared, /purpose\?: "acknowledgement"/u);
  assert.match(trace, /event\.purpose === "acknowledgement"[\s\S]*initialAcknowledgement =/u);
  assert.match(trace, /className=\{styles\.initialAcknowledgement\}[\s\S]*aria-live="polite"/u);
  assert.match(styles, /\.initialAcknowledgement[\s\S]*light-dark\(#343538, #d6d9e0\)/u);
  assert.match(trace, /model\.commentaryUpdates\.length > 0/u);
  assert.doesNotMatch(trace, /model\.trace\.length > 0 && Boolean\(model\.plan\)/u);
});
