import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONVERSATION_TITLE_MODEL,
  generateConversationTitle,
  sanitizeConversationTitle,
} from "./src/conversation-title.js";

describe("conversation titles", () => {
  it("uses the cheap nano model id", () => {
    assert.equal(CONVERSATION_TITLE_MODEL, "gpt-5-nano");
  });

  it("sanitises model output into a short title", () => {
    assert.equal(
      sanitizeConversationTitle('  "Customer purchases last 30 days."  '),
      "Customer purchases last 30 days",
    );
    assert.equal(sanitizeConversationTitle("Untitled"), null);
    assert.equal(sanitizeConversationTitle(""), null);
  });

  it("generates a title from the user question via OpenAI responses", async () => {
    const calls: unknown[] = [];
    const title = await generateConversationTitle({
      question: "How many customers bought from us in the last 30 days?",
      apiKey: "test-key",
      baseUrl: "https://example.invalid/v1",
      client: {
        responses: {
          async create(body: unknown) {
            calls.push(body);
            return { output_text: "Customer purchases last 30 days" };
          },
        },
      } as never,
    });
    assert.equal(title, "Customer purchases last 30 days");
    assert.equal(calls.length, 1);
    const body = calls[0] as {
      model: string;
      store: boolean;
      reasoning: { effort: string };
      input: ReadonlyArray<{ role: string; content: string }>;
    };
    assert.equal(body.model, "gpt-5-nano");
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, "minimal");
    assert.match(body.input.at(-1)?.content ?? "", /How many customers/u);
  });
});
