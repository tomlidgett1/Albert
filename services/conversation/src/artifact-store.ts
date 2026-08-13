import { z } from "zod";
import {
  ALBERT_PREFERENCE_OPTION_IDS,
  type AlbertPreferenceOptionId,
} from "../../../packages/agent/src/v3-contracts.js";
import type {
  ResolvedConversationSubject,
  TraceEvent,
} from "../../../packages/shared/src/index.js";
import { ControlPlaneError, requireUser } from "../../control-plane/src/web-repository.js";

const beginResultSchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  previous_response_id: z.string().nullable().optional(),
  confirmed_option_id: z.enum(ALBERT_PREFERENCE_OPTION_IDS).nullable().optional(),
  confirmed_preference: z.string().min(1).max(120).nullable().optional(),
  confirmed_value: z.string().min(1).max(300).nullable().optional(),
});

const modelContextSchema = z.array(z.object({
  turn_number: z.number().int().positive(),
  user_message: z.string().min(1).max(40_000),
  status: z.string(),
  assistant_event: z.object({
    type: z.enum(["answer", "clarification"]),
    text: z.string().min(1).max(16_000).nullish(),
    question: z.string().min(1).max(300).nullish(),
    provenance: z.record(z.string(), z.unknown()).optional(),
    resolvedSubject: z.object({
      label: z.string().trim().min(1).max(160),
      kind: z.string().trim().min(1).max(80),
      resolvedQuestion: z.string().trim().min(1).max(2_000),
    }).strict().optional(),
  }).passthrough().nullable(),
}));

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export type BegunConversationTurn = Readonly<{
  conversationId: string;
  previousResponseId?: string;
  confirmedPreference?: Readonly<{
    optionId: AlbertPreferenceOptionId;
    preference: string;
    value: string;
  }>;
}>;

export type ConversationTitleAssignment = Readonly<{
  title: string;
  assigned: boolean;
}>;

export type ConversationModelMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
  resolvedSubject?: ResolvedConversationSubject;
  /**
   * Governed Cube and typed live Shopify queries that produced this assistant
   * answer. Albert v3 provenance definitions let follow-up turns extend the
   * previous query without guessing its execution plane.
   */
  governedQueries?: readonly Readonly<{
    view: string;
    topic: string;
    queryYaml: string;
  }>[];
}>;

/** Supabase client captured before an SSE response starts streaming. */
export type ConversationSupabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

async function resolveSupabase(client?: ConversationSupabase): Promise<ConversationSupabase> {
  if (client) return client;
  return (await requireUser()).supabase;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code : undefined;
}

function postgresErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message.trim() : undefined;
}

export function isConversationTurnStillRunningError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  const message = postgresErrorMessage(error) ?? "";
  return code === "55000" || /another turn is already running/iu.test(message);
}

export function isConversationRuntimeLockError(error: unknown): boolean {
  const code = postgresErrorCode(error);
  const message = postgresErrorMessage(error) ?? "";
  return code === "23514" || /conversation analytics runtime is immutable/iu.test(message);
}

function historyTurns(data: unknown): readonly Record<string, unknown>[] {
  const payload = singleton(data);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const turns = (payload as { turns?: unknown }).turns;
  if (!Array.isArray(turns)) return [];
  return turns.filter((turn): turn is Record<string, unknown> => (
    Boolean(turn) && typeof turn === "object" && !Array.isArray(turn)
  ));
}

function beginTurnFailure(error: unknown): ControlPlaneError {
  if (isConversationRuntimeLockError(error)) {
    return new ControlPlaneError(
      "This conversation belongs to a different analytics method.",
      409,
    );
  }
  if (isConversationTurnStillRunningError(error)) {
    return new ControlPlaneError(
      "The conversation could not be started because a previous turn is still running.",
      409,
    );
  }
  const detail = postgresErrorMessage(error);
  return new ControlPlaneError(
    detail ? `The conversation could not be started. ${detail}` : "The conversation could not be started.",
    503,
  );
}

/** Owner follow-up / abort: fail a running turn so the next begin can proceed. */
export async function releaseConversationTurnIfRunning(input: Readonly<{
  conversationId: string;
  turnId: string;
  failureCode?: string;
  supabase?: ConversationSupabase;
}>): Promise<void> {
  const supabase = await resolveSupabase(input.supabase);
  const { error } = await supabase.rpc("fail_albert_turn", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_failure_code: input.failureCode ?? "client_replaced_turn",
  });
  if (!error) return;
  const code = postgresErrorCode(error);
  // Already failed is a no-op in SQL. Missing / not-running means begin can proceed.
  if (code === "P0002" || code === "55000") return;
}

export async function releaseRunningConversationTurns(input: Readonly<{
  conversationId: string;
  failureCode?: string;
  supabase?: ConversationSupabase;
}>): Promise<void> {
  const supabase = await resolveSupabase(input.supabase);
  const { data } = await supabase.rpc("albert_conversation_history", {
    p_conversation_id: input.conversationId,
    p_after_sequence: 0,
  });
  for (const turn of historyTurns(data)) {
    if (turn.status !== "running" || typeof turn.turn_id !== "string") continue;
    await releaseConversationTurnIfRunning({
      conversationId: input.conversationId,
      turnId: turn.turn_id,
      failureCode: input.failureCode ?? "stale_lease_released",
      supabase,
    });
  }
}

export async function beginConversationTurn(input: Readonly<{
  conversationId?: string;
  turnId: string;
  message: string;
  runtimeProfile: Readonly<Record<string, unknown>>;
  confirmedOption?: Readonly<{ offeredTurnId: string; optionId: string }>;
  replaceTurnId?: string;
  replaceFailureCode?: string;
  staleLeaseFailureCode?: string;
  supabase?: ConversationSupabase;
}>): Promise<BegunConversationTurn> {
  const supabase = await resolveSupabase(input.supabase);
  if (input.replaceTurnId && input.conversationId) {
    await releaseConversationTurnIfRunning({
      conversationId: input.conversationId,
      turnId: input.replaceTurnId,
      failureCode: input.replaceFailureCode ?? "client_replaced_turn",
      supabase,
    });
  }

  const begin = () => supabase.rpc("begin_albert_turn", {
    p_conversation_id: input.conversationId ?? null,
    p_turn_id: input.turnId,
    p_user_message: input.message,
    p_runtime_profile: input.runtimeProfile,
    p_confirmation_turn_id: input.confirmedOption?.offeredTurnId ?? null,
    p_confirmation_option_id: input.confirmedOption?.optionId ?? null,
  });

  let { data, error } = await begin();
  if (error && input.conversationId && isConversationTurnStillRunningError(error)) {
    await releaseRunningConversationTurns({
      conversationId: input.conversationId,
      failureCode: input.staleLeaseFailureCode ?? "stale_lease_released",
      supabase,
    });
    ({ data, error } = await begin());
  }
  if (error) throw beginTurnFailure(error);
  const parsed = beginResultSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The conversation service returned invalid state.", 503);
  return Object.freeze({
    conversationId: parsed.data.conversation_id,
    previousResponseId: parsed.data.previous_response_id ?? undefined,
    ...(parsed.data.confirmed_option_id && parsed.data.confirmed_preference && parsed.data.confirmed_value ? {
      confirmedPreference: Object.freeze({
        optionId: parsed.data.confirmed_option_id,
        preference: parsed.data.confirmed_preference,
        value: parsed.data.confirmed_value,
      }),
    } : {}),
  });
}

/**
 * Extends a running turn's durable lease. The reaper exists to recover turns
 * whose runner died; a runner that is still streaming says so here, so an
 * unbounded analytical turn is never mistaken for an abandoned one.
 */
export async function renewConversationTurnLease(input: Readonly<{
  supabase: ConversationSupabase;
  turnId: string;
  leaseSeconds?: number;
}>): Promise<boolean> {
  const { data, error } = await input.supabase.rpc("renew_albert_turn_lease", {
    p_turn_id: input.turnId,
    p_lease_seconds: input.leaseSeconds ?? 360,
  });
  if (error) return false;
  return singleton(data) !== null && singleton(data) !== undefined;
}

export async function conversationNeedsTitle(
  conversationId: string,
  supabaseClient?: ConversationSupabase,
): Promise<boolean> {
  const supabase = await resolveSupabase(supabaseClient);
  const { data, error } = await supabase.rpc("albert_conversation_needs_title", {
    p_conversation_id: conversationId,
  });
  if (error) {
    throw new ControlPlaneError(
      `Conversation title state could not be loaded: ${error.message}`,
      503,
    );
  }
  return data === true;
}

export async function assignConversationTitle(input: Readonly<{
  conversationId: string;
  title: string;
  supabase?: ConversationSupabase;
}>): Promise<ConversationTitleAssignment> {
  const supabase = await resolveSupabase(input.supabase);
  const { data, error } = await supabase.rpc("albert_assign_conversation_title", {
    p_conversation_id: input.conversationId,
    p_title: input.title,
  });
  if (error) {
    throw new ControlPlaneError(
      `The conversation title could not be saved: ${error.message}`,
      503,
    );
  }
  const parsed = z.object({
    title: z.string().trim().min(1).max(120),
    assigned: z.boolean(),
  }).safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Conversation title returned invalid state.", 503);
  return Object.freeze(parsed.data);
}

export type ConversationRewindResult = Readonly<{
  conversationId: string;
  fromTurnId: string;
  fromTurnNumber: number;
  hiddenTurnCount: number;
  failedRunningCount: number;
}>;

export async function rewindConversationFromTurn(input: Readonly<{
  conversationId: string;
  fromTurnId: string;
  supabase?: ConversationSupabase;
}>): Promise<ConversationRewindResult> {
  const supabase = await resolveSupabase(input.supabase);
  const { data, error } = await supabase.rpc("albert_rewind_conversation_from_turn", {
    p_conversation_id: input.conversationId,
    p_from_turn_id: input.fromTurnId,
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "P0002"
        ? "The conversation turn could not be found."
        : "The conversation could not be rewound.",
      error.code === "P0002" ? 404 : 503,
    );
  }
  const parsed = z.object({
    conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    from_turn_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    from_turn_number: z.number().int().positive(),
    hidden_turn_count: z.number().int().nonnegative(),
    failed_running_count: z.number().int().nonnegative(),
  }).safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("Conversation rewind returned invalid state.", 503);
  }
  return Object.freeze({
    conversationId: parsed.data.conversation_id,
    fromTurnId: parsed.data.from_turn_id,
    fromTurnNumber: parsed.data.from_turn_number,
    hiddenTurnCount: parsed.data.hidden_turn_count,
    failedRunningCount: parsed.data.failed_running_count,
  });
}

const MAX_GOVERNED_QUERIES_PER_ANSWER = 8;

/**
 * Albert v3 answers persist each executed governed query in the answer event's
 * provenance. Cube definitions use `cube.yaml:<view>`; typed live Shopify
 * definitions use `shopifyql.ir:<report>` and `shopify-admin.ir:<resource>`.
 * Restore the execution-plane namespace so follow-up turns can extend the
 * previous query instead of guessing. Other runtimes' provenance is ignored.
 */
function governedQueriesFromAnswerEvent(
  event: Readonly<Record<string, unknown>>,
): readonly Readonly<{ view: string; topic: string; queryYaml: string }>[] {
  const provenance = event.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return [];
  const definitions = (provenance as Record<string, unknown>).definitions;
  if (!Array.isArray(definitions)) return [];
  const governed: { view: string; topic: string; queryYaml: string }[] = [];
  for (const definition of definitions) {
    if (governed.length >= MAX_GOVERNED_QUERIES_PER_ANSWER) break;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) continue;
    const row = definition as Record<string, unknown>;
    if (
      typeof row.metric !== "string"
      || typeof row.definition !== "string"
      || row.definition.length === 0
      || row.definition.length > 4_000
    ) continue;
    const view = row.metric.startsWith("cube.yaml:")
      ? row.metric.slice("cube.yaml:".length)
      : row.metric.startsWith("shopifyql.ir:")
        ? `shopifyql:${row.metric.slice("shopifyql.ir:".length)}`
        : row.metric.startsWith("shopify-admin.ir:")
          ? `shopify-admin:${row.metric.slice("shopify-admin.ir:".length)}`
          : undefined;
    if (!view) continue;
    governed.push(Object.freeze({
      view,
      topic: typeof row.label === "string" ? row.label.slice(0, 160) : "Governed query",
      queryYaml: row.definition,
    }));
  }
  return Object.freeze(governed);
}

export async function loadConversationModelContext(
  conversationId: string,
  supabaseClient?: ConversationSupabase,
): Promise<readonly ConversationModelMessage[]> {
  const supabase = await resolveSupabase(supabaseClient);
  const { data, error } = await supabase.rpc("albert_model_context", {
    p_conversation_id: conversationId,
    p_turn_limit: 12,
  });
  if (error) throw new ControlPlaneError("The bounded conversation context could not be loaded.", 503);
  const parsed = modelContextSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("The conversation context returned invalid state.", 503);
  const messages = parsed.data.flatMap((turn): ConversationModelMessage[] => {
    const values: ConversationModelMessage[] = [{ role: "user", text: turn.user_message }];
    const event = turn.assistant_event;
    if (event?.type === "answer" && event.text) values.push({
      role: "assistant",
      text: event.text,
      ...(event.resolvedSubject ? { resolvedSubject: Object.freeze({ ...event.resolvedSubject }) } : {}),
      ...(() => {
        const governed = governedQueriesFromAnswerEvent(event);
        return governed.length > 0 ? { governedQueries: governed } : {};
      })(),
    });
    if (event?.type === "clarification" && event.question) values.push({ role: "assistant", text: event.question });
    return values;
  });
  return Object.freeze(messages.map((message) => Object.freeze(message)));
}

export async function appendConversationEvent(input: Readonly<{
  conversationId: string;
  turnId: string;
  event: TraceEvent;
  supabase?: ConversationSupabase;
}>): Promise<void> {
  const supabase = await resolveSupabase(input.supabase);
  const { error } = await supabase.rpc("albert_answer_event_append", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_event: input.event,
  });
  if (error) throw new ControlPlaneError("The conversation trace could not be persisted.", 503);
}

export async function completeConversationTurn(input: Readonly<{
  conversationId: string;
  turnId: string;
  providerResponseId: string;
  usage: Readonly<Record<string, unknown>>;
  answerState: string;
  resultDigest: string;
  supabase?: ConversationSupabase;
}>): Promise<void> {
  const supabase = await resolveSupabase(input.supabase);
  const { error } = await supabase.rpc("complete_albert_turn", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_provider_response_id: input.providerResponseId,
    p_usage: input.usage,
    p_answer_state: input.answerState.toLowerCase(),
    p_result_digest: input.resultDigest,
  });
  if (error) throw new ControlPlaneError("The completed conversation could not be persisted.", 503);
}

export async function failConversationTurn(input: Readonly<{
  conversationId: string;
  turnId: string;
  failureCode: string;
  supabase?: ConversationSupabase;
}>): Promise<void> {
  const supabase = await resolveSupabase(input.supabase);
  const { error } = await supabase.rpc("fail_albert_turn", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_failure_code: input.failureCode,
  });
  if (error) throw new ControlPlaneError("The failed conversation turn could not be finalized.", 503);
}
