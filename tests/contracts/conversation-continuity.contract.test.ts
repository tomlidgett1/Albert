import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  loadConversationModelContext,
  type ConversationSupabase,
} from "../../services/conversation/src/artifact-store.js";
import { contextualTurnInterpretationInput } from "../../services/conversation/src/conversation-understanding.js";

const migration = readFileSync(
  new URL("../../infra/migrations/control-plane/0097_m6_persisted_resolved_subject.sql", import.meta.url),
  "utf8",
);

test("the sealed answer subject is returned with bounded model context while hidden turns stay excluded", () => {
  assert.match(migration, /answer_execution_events/u);
  assert.match(migration, /event_payload->'resolvedSubject'/u);
  assert.match(migration, /turn\.hidden_at IS NULL/u);
  assert.match(migration, /event_type = 'answer'/u);
  assert.match(migration, /jsonb_typeof\(recent\.resolved_subject\) = 'object'/u);
});

test("artifact context carries the exact persisted subject into the next turn", async () => {
  const subject = {
    label: "Tom Lidgett",
    kind: "customer",
    resolvedQuestion: "What is the most recent sale for Tom Lidgett?",
  };
  const supabase = {
    rpc: async (name: string) => {
      assert.equal(name, "albert_model_context");
      return {
        error: null,
        data: [{
          turn_number: 1,
          user_message: "What is the most recent sale for Tom Lidgett?",
          status: "completed",
          assistant_event: {
            type: "answer",
            text: "The most recent sale is 61740.",
            resolvedSubject: subject,
          },
        }],
      };
    },
  } as unknown as ConversationSupabase;

  const messages = await loadConversationModelContext("conversation_test", supabase);
  assert.deepEqual(messages, [
    { role: "user", text: "What is the most recent sale for Tom Lidgett?" },
    {
      role: "assistant",
      text: "The most recent sale is 61740.",
      resolvedSubject: subject,
    },
  ]);

  const packet = JSON.parse(contextualTurnInterpretationInput(
    [...messages, { role: "user", text: "They are the only transactions?" }],
    "They are the only transactions?",
  )) as Readonly<Record<string, unknown>>;
  assert.deepEqual(packet.latestPersistedSubject, subject);
  assert.equal(packet.currentMessage, "They are the only transactions?");
});
