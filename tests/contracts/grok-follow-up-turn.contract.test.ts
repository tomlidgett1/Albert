import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  beginConversationTurn,
  isConversationRuntimeLockError,
  isConversationTurnStillRunningError,
  type ConversationSupabase,
} from "../../services/conversation/src/artifact-store.js";
import { ControlPlaneError } from "../../services/control-plane/src/web-repository.js";

const read = (path: string) => readFileSync(resolve(path), "utf8");
const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const previousTurnId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const nextTurnId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";

function mockSupabase(
  rpc: ConversationSupabase["rpc"],
): ConversationSupabase {
  return { rpc } as ConversationSupabase;
}

test("Postgres 55000 is a still-running turn, not the runtime lock", () => {
  assert.equal(
    isConversationTurnStillRunningError({
      code: "55000",
      message: "another turn is already running for this conversation",
    }),
    true,
  );
  assert.equal(
    isConversationRuntimeLockError({
      code: "23514",
      message: "conversation analytics runtime is immutable",
    }),
    true,
  );
  assert.equal(
    isConversationTurnStillRunningError({
      code: "23514",
      message: "conversation analytics runtime is immutable",
    }),
    false,
  );
});

test("beginConversationTurn releases the previous turn before starting a follow-up", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const supabase = mockSupabase(async (name, args) => {
    calls.push({ name, args: (args ?? {}) as Record<string, unknown> });
    if (name === "fail_albert_turn") return { data: null, error: null };
    if (name === "begin_albert_turn") {
      return { data: { conversation_id: conversationId }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  const begun = await beginConversationTurn({
    conversationId,
    turnId: nextTurnId,
    message: "And last month?",
    runtimeProfile: { runtime: "albert-v3", model: "grok-4.6" },
    replaceTurnId: previousTurnId,
    supabase,
  });

  assert.equal(begun.conversationId, conversationId);
  assert.deepEqual(calls.map((call) => call.name), ["fail_albert_turn", "begin_albert_turn"]);
  assert.equal(calls[0]?.args.p_turn_id, previousTurnId);
  assert.equal(calls[0]?.args.p_failure_code, "client_replaced_turn");
});

test("beginConversationTurn recovers a still-running lease and retries", async () => {
  const calls: string[] = [];
  const supabase = mockSupabase(async (name, args) => {
    calls.push(name);
    if (name === "begin_albert_turn" && calls.filter((item) => item === "begin_albert_turn").length === 1) {
      return {
        data: null,
        error: { code: "55000", message: "another turn is already running for this conversation" },
      };
    }
    if (name === "albert_conversation_history") {
      return {
        data: { turns: [{ status: "running", turn_id: previousTurnId }] },
        error: null,
      };
    }
    if (name === "fail_albert_turn") {
      assert.equal((args as { p_turn_id?: string }).p_turn_id, previousTurnId);
      return { data: null, error: null };
    }
    if (name === "begin_albert_turn") {
      return { data: { conversation_id: conversationId }, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  const begun = await beginConversationTurn({
    conversationId,
    turnId: nextTurnId,
    message: "And last month?",
    runtimeProfile: { runtime: "albert-v3", model: "grok-4.6" },
    staleLeaseFailureCode: "albert_v3_stale_lease_released",
    supabase,
  });

  assert.equal(begun.conversationId, conversationId);
  assert.deepEqual(calls, [
    "begin_albert_turn",
    "albert_conversation_history",
    "fail_albert_turn",
    "begin_albert_turn",
  ]);
});

test("a runtime lock is not swallowed as a generic start 503", async () => {
  const supabase = mockSupabase(async (name) => {
    if (name === "begin_albert_turn") {
      return {
        data: null,
        error: { code: "23514", message: "conversation analytics runtime is immutable" },
      };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  await assert.rejects(
    () => beginConversationTurn({
      conversationId,
      turnId: nextTurnId,
      message: "And last month?",
      runtimeProfile: { runtime: "openai-agents-sdk", model: "grok-4.6" },
      supabase,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ControlPlaneError);
      assert.equal(error.status, 409);
      assert.match(error.message, /different analytics method/u);
      assert.doesNotMatch(error.message, /^The conversation could not be started\.$/u);
      return true;
    },
  );
});

test("Grok follow-ups stay on Albert v3 and replace the previous turn", () => {
  const dash = read("app/dash/page.tsx");
  const v3 = read("app/api/v3-conversation/route.ts");
  const v1 = read("app/api/conversation/route.ts");
  const history = read("infra/migrations/control-plane/0137_m8_conversation_followup_runtime.sql");
  const schema = read("services/control-plane/src/web-repository.ts");

  assert.match(dash, /profile\.model === "grok-4.6"/u);
  assert.match(dash, /isXaiModel\(runPreferences\.model\)/u);
  assert.match(dash, /replaceTurnId/u);
  assert.match(v3, /replaceTurnId/u);
  assert.match(v3, /beginConversationTurn/u);
  assert.match(v1, /replaceTurnId/u);
  assert.match(history, /'runtime', turn\.runtime_profile->'runtime'/u);
  assert.match(history, /'analyticalRuntime', turn\.runtime_profile->'analyticalRuntime'/u);
  assert.match(history, /OR turn\.status = 'failed'/u);
  assert.doesNotMatch(
    history,
    /turn\.result_digest IN \(\s*'albert_v3_answered'/u,
  );
  assert.match(schema, /runtime: z\.string\(\)\.nullish\(\)/u);
});
