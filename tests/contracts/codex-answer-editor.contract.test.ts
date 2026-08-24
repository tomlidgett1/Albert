import assert from "node:assert/strict";
import test from "node:test";

import { editCodexAnswerForTightness } from "../../packages/albert-codex/src/answer-editor.ts";

// The editor targets sprawl: the caller only invokes it above 2,400 chars, so
// its unit fixture is a genuinely long answer.
const LONG_ANSWER = [
  "**Revenue held flat while net profit went negative.**",
  "Gross takings were $621,131.24 across 4,663 transactions in 2025 against $602,503.21 in 2024.",
  "The workshop carried the margin: services gross margin was 97.33% on $129,434.88 of revenue.",
].join("\n\n").padEnd(3_000, " detail");

const baseOptions = {
  apiKey: "sk-fixture",
  baseUrl: "http://127.0.0.1:9",
  model: "gpt-5.6-luna",
  fastMode: true,
  safetyIdentifier: "fixture",
  question: "How is the business performing?",
  answer: LONG_ANSWER,
} as const;

// The editorial pass runs after a validated answer already exists, so its
// hard contract is fail-open: any defect returns null and the turn ships the
// validated answer. A thrown editor is exactly the class of defect that
// discarded a completed seven-minute analysis on 2026-08-23.
test("a client whose construction fails yields null, never a throw", async () => {
  const edited = await editCodexAnswerForTightness({
    ...baseOptions,
    // Empty credentials make the OpenAI constructor itself throw; that throw
    // must stay inside the editor.
    apiKey: "",
    baseUrl: "",
  });
  assert.equal(edited, null);
});

test("a client whose request rejects yields null, never a throw", async () => {
  const edited = await editCodexAnswerForTightness({
    ...baseOptions,
    client: {
      responses: {
        create: async () => {
          throw new Error("boom: simulated transport failure");
        },
      },
    } as never,
  });
  assert.equal(edited, null);
});

test("an aborted signal yields null, never a throw", async () => {
  const controller = new AbortController();
  controller.abort(new Error("turn cancelled"));
  const edited = await editCodexAnswerForTightness({
    ...baseOptions,
    signal: controller.signal,
    client: {
      responses: {
        create: async (_body: unknown, requestOptions?: { signal?: AbortSignal }) => {
          requestOptions?.signal?.throwIfAborted();
          return { output_text: LONG_ANSWER };
        },
      },
    } as never,
  });
  assert.equal(edited, null);
});

test("a shortening edit is returned; a gutted or grown edit is rejected", async () => {
  const shortened = LONG_ANSWER.slice(0, Math.floor(LONG_ANSWER.length * 0.7)).trim();
  const makeClient = (outputText: string) => ({
    responses: { create: async () => ({ output_text: outputText }) },
  }) as never;
  assert.equal(
    await editCodexAnswerForTightness({ ...baseOptions, client: makeClient(shortened) }),
    shortened,
  );
  assert.equal(
    await editCodexAnswerForTightness({ ...baseOptions, client: makeClient(`${LONG_ANSWER} plus new trailing content`) }),
    null,
  );
  // Measured on goal-seek turns (2026-08-23): "tightening" that halves the
  // answer removes the named levers that made it an answer. An edit keeping
  // less than 55% of the original (or under 900 chars) is a gut, not an edit.
  assert.equal(
    await editCodexAnswerForTightness({
      ...baseOptions,
      client: makeClient(LONG_ANSWER.slice(0, Math.floor(LONG_ANSWER.length * 0.45)).trim()),
    }),
    null,
  );
  assert.equal(
    await editCodexAnswerForTightness({ ...baseOptions, client: makeClient("Too short.") }),
    null,
  );
});
