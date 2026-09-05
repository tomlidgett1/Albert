import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  loadConversationModelContext,
  type ConversationSupabase,
} from "../../services/conversation/src/artifact-store.js";
import { contextualTurnInterpretationInput } from "../../services/conversation/src/conversation-understanding.js";

const migration = readFileSync(
  new URL("../../infra/migrations/control-plane/0115_m8_v3_trace_model_context.sql", import.meta.url),
  "utf8",
);

test("lease-released v3 turns return terminal trace provenance in bounded model context", () => {
  assert.match(migration, /albert_v3_answered/u);
  assert.match(migration, /terminal_event->'provenance'/u);
  assert.match(migration, /turn\.hidden_at IS NULL/u);
  assert.match(migration, /albert_conversation_history/u);
});

test("artifact context carries governed Cube queries from answer provenance", async () => {
  const queryYaml = "measures:\n  - sales.gross_takings\n";
  const supabase = {
    rpc: async (name: string) => {
      assert.equal(name, "albert_model_context");
      return {
        error: null,
        data: [{
          turn_number: 1,
          user_message: "Show monthly sales",
          status: "failed",
          assistant_event: {
            type: "answer",
            text: "Here is monthly sales.",
            provenance: {
              definitions: [{
                metric: "cube.yaml:sales_overview",
                label: "Monthly sales",
                definition: queryYaml,
              }],
            },
            resolvedSubject: {
              label: "Monthly sales table",
              kind: "quick",
              resolvedQuestion: "Show a table of monthly sales",
            },
          },
        }],
      };
    },
  } as unknown as ConversationSupabase;

  const messages = await loadConversationModelContext("conversation_test", supabase);
  assert.equal(messages[1]?.governedQueries?.[0]?.queryYaml, queryYaml);
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

test("model context accepts a JSON-null answer text without failing the follow-up", async () => {
  const supabase = {
    rpc: async (name: string) => {
      assert.equal(name, "albert_model_context");
      return {
        error: null,
        data: [{
          turn_number: 1,
          user_message: "Show sales",
          status: "failed",
          assistant_event: {
            type: "answer",
            text: null,
            provenance: { definitions: [] },
          },
        }],
      };
    },
  } as unknown as ConversationSupabase;

  const messages = await loadConversationModelContext("conversation_test", supabase);
  assert.deepEqual(messages, [
    { role: "user", text: "Show sales" },
    {
      role: "assistant",
      text: "(No answer was produced for this message: the attempt was interrupted before it finished. There are no figures, tables or charts from it to refine; treat any follow-up as a fresh request built on the message above.)",
    },
  ]);
});
