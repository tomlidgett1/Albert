import assert from "node:assert/strict";
import test from "node:test";

import { createLiveTraceSseResponse } from "../../services/conversation/src/sse.ts";

test("Codex-style SSE disconnects stop delivery but keep the bounded server turn alive", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  let runtimeSignal: AbortSignal | undefined;
  const response = createLiveTraceSseResponse({
    conversationId: "01J00000000000000000000301",
    turnId: "01J00000000000000000000302",
    continueOnClientDisconnect: true,
    async run(stream, signal) {
      runtimeSignal = signal;
      stream.emitConversationTitle("Fixture analysis");
      await gate;
      assert.equal(signal.aborted, false);
      completed = true;
    },
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.cancel("response_closed");
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runtimeSignal?.aborted, false);
  assert.equal(completed, true);
});

test("ordinary SSE disconnects retain the existing cancellation contract", async () => {
  let runtimeSignal: AbortSignal | undefined;
  let observeAbort!: () => void;
  const aborted = new Promise<void>((resolve) => { observeAbort = resolve; });
  const response = createLiveTraceSseResponse({
    conversationId: "01J00000000000000000000303",
    turnId: "01J00000000000000000000304",
    async run(_stream, signal) {
      runtimeSignal = signal;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
        observeAbort();
        resolve();
      }, { once: true }));
    },
  });
  const reader = response.body?.getReader();
  assert.ok(reader);
  await reader.cancel("response_closed");
  await aborted;
  assert.equal(runtimeSignal?.aborted, true);
});
