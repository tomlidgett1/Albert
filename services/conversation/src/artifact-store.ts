import { z } from "zod";
import {
  ALBERT_PREFERENCE_OPTION_IDS,
  type AlbertPreferenceOptionId,
} from "../../../packages/agent/src/semantic-tools.js";
import type {
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
    text: z.string().min(1).max(4_000).optional(),
    question: z.string().min(1).max(300).optional(),
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

export type ConversationModelMessage = Readonly<{
  role: "user" | "assistant";
  text: string;
}>;

export async function beginConversationTurn(input: Readonly<{
  conversationId?: string;
  turnId: string;
  message: string;
  runtimeProfile: Readonly<Record<string, unknown>>;
  confirmedOption?: Readonly<{ offeredTurnId: string; optionId: string }>;
}>): Promise<BegunConversationTurn> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("begin_albert_turn", {
    p_conversation_id: input.conversationId ?? null,
    p_turn_id: input.turnId,
    p_user_message: input.message,
    p_runtime_profile: input.runtimeProfile,
    p_confirmation_turn_id: input.confirmedOption?.offeredTurnId ?? null,
    p_confirmation_option_id: input.confirmedOption?.optionId ?? null,
  });
  if (error) throw new ControlPlaneError("The conversation could not be started.", 503);
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

export async function loadConversationModelContext(
  conversationId:string,
):Promise<readonly ConversationModelMessage[]> {
  const { supabase } = await requireUser();
  const { data,error } = await supabase.rpc("albert_model_context",{
    p_conversation_id:conversationId,
    p_turn_limit:12,
  });
  if(error)throw new ControlPlaneError("The bounded conversation context could not be loaded.",503);
  const parsed=modelContextSchema.safeParse(data);
  if(!parsed.success)throw new ControlPlaneError("The conversation context returned invalid state.",503);
  const messages=parsed.data.flatMap((turn):ConversationModelMessage[]=>{
    const values:ConversationModelMessage[]=[{role:"user",text:turn.user_message}];
    const event=turn.assistant_event;
    if(event?.type==="answer"&&event.text)values.push({role:"assistant",text:event.text});
    if(event?.type==="clarification"&&event.question)values.push({role:"assistant",text:event.question});
    return values;
  });
  return Object.freeze(messages.map((message)=>Object.freeze(message)));
}

export async function appendConversationEvent(input: Readonly<{
  conversationId: string;
  turnId: string;
  event: TraceEvent;
}>): Promise<void> {
  const { supabase } = await requireUser();
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
}>): Promise<void> {
  const { supabase } = await requireUser();
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
}>): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("fail_albert_turn", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_failure_code: input.failureCode,
  });
  if (error) throw new ControlPlaneError("The failed conversation turn could not be finalized.", 503);
}
