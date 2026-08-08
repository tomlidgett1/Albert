import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = read("infra/migrations/control-plane/0094_m8_conversation_rewind_from_turn.sql");
const route = read("app/api/conversations/[conversationId]/rewind/route.ts");
const artifactStore = read("services/conversation/src/artifact-store.ts");
const dashPage = read("app/dash/page.tsx");

test("rewind soft-hides later turns instead of minting a new conversation", () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS hidden_at timestamptz/u);
  assert.match(migration, /albert_rewind_conversation_from_turn/u);
  assert.match(migration, /result_digest = 'conversation_rewound'/u);
  assert.match(migration, /turn\.hidden_at IS NULL/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.begin_albert_turn_core_v1/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_conversation_history/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_model_context/u);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.albert_list_conversations/u);
});

test("rewind is exposed through a same-origin authenticated API", () => {
  assert.match(route, /assertSameOriginMutation/u);
  assert.match(route, /rewindConversationFromTurn/u);
  assert.match(route, /fromTurnId/u);
  assert.match(artifactStore, /albert_rewind_conversation_from_turn/u);
});

test("edit-and-resend keeps the active conversation and confirms before discarding later messages", () => {
  assert.match(dashPage, /editResendConfirm/u);
  assert.match(dashPage, /Rerun from here/u);
  assert.match(dashPage, /\/api\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/rewind/u);
  assert.match(dashPage, /conversationId: conversationId \?\? null/u);
  assert.doesNotMatch(dashPage, /setActiveConversationId\(undefined\);\s*setTakeawaysOpen\(false\);\s*void sendChatMessage\(text, undefined, \{\s*conversationId: null/u);
});

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}
