import { z } from "zod";
import { createClient } from "../../../utils/supabase/server.js";
import { toConnectionsWorkspace } from "./connections-workspace.js";

const tenantContextSchema = z.object({
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  tenant_name: z.string().min(1),
  tenant_slug: z.string().min(1),
  role: z.enum(["owner", "manager", "bookkeeper", "internal_operator"]),
  timezone: z.string().min(1).default("Australia/Melbourne"),
});

const runtimeProfileSchema = z.object({
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  fastMode: z.boolean().optional(),
});

const conversationSummarySchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  title: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_turn: z.object({
    turn_id: z.string(),
    turn_number: z.number().int().positive(),
    user_message: z.string(),
    status: z.string(),
    answer_state: z.string().nullable(),
    runtime_profile: runtimeProfileSchema,
    created_at: z.string(),
    completed_at: z.string().nullable(),
  }).nullable(),
});

const conversationHistorySchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  turns: z.array(z.object({
    turn_id: z.string(),
    turn_number: z.number().int().positive(),
    user_message: z.string(),
    status: z.string(),
    answer_state: z.string().nullable(),
    runtime_profile: runtimeProfileSchema,
    created_at: z.string(),
    completed_at: z.string().nullable(),
    events: z.array(z.unknown()),
  })),
  next_sequence: z.number().int().nonnegative(),
});

export type TenantContext = z.infer<typeof tenantContextSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;

export const ALBERT_RATE_LIMIT_POLICIES = Object.freeze({
  "conversation.turn": Object.freeze({ limit: 20, windowSeconds: 60 }),
  "oauth.start": Object.freeze({ limit: 5, windowSeconds: 600 }),
  "oauth.callback": Object.freeze({ limit: 10, windowSeconds: 600 }),
  "oauth.select": Object.freeze({ limit: 10, windowSeconds: 600 }),
  "oauth.disconnect": Object.freeze({ limit: 5, windowSeconds: 3_600 }),
  "review.mutation": Object.freeze({ limit: 30, windowSeconds: 60 }),
} as const);

export type AlbertRateLimitAction = keyof typeof ALBERT_RATE_LIMIT_POLICIES;
export type AlbertRateLimitDecision = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
}>;

function singleton(value: unknown): unknown {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export async function requireUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ControlPlaneError("Authentication is required.", 401);
  return { supabase, user: data.user };
}

export async function currentTenantContext(): Promise<TenantContext | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("current_albert_context");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The Albert control-plane migration is not deployed.", 503);
    }
    throw new ControlPlaneError("The organisation context could not be loaded.", 503);
  }
  const candidate = singleton(data);
  if (!candidate) return null;
  const parsed = tenantContextSchema.safeParse(candidate);
  if (!parsed.success) throw new ControlPlaneError("The organisation context is invalid.", 503);
  return parsed.data;
}

export async function bootstrapTenant(input: Readonly<{
  displayName: string;
  timezone: string;
}>): Promise<TenantContext> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("bootstrap_albert_tenant", {
    p_display_name: input.displayName,
    p_timezone: input.timezone,
  });
  if (error) throw new ControlPlaneError("Your organisation could not be created.", 503);
  const parsed = tenantContextSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The created organisation is invalid.", 503);
  return parsed.data;
}

export async function loadConnectionsWorkspace(): Promise<unknown> {
  const { supabase } = await requireUser();
  const context = await currentTenantContext();
  if (!context) throw new ControlPlaneError("Create your organisation before loading connections.", 409);
  const { data, error } = await supabase.rpc("albert_connections_workspace");
  if (error) throw new ControlPlaneError("Connection status could not be loaded.", 503);
  return toConnectionsWorkspace(singleton(data), context.timezone);
}

export async function answerBlockingQuestion(questionId: string, optionId: string): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_answer_blocking_question", {
    p_question_id: questionId,
    p_option_id: optionId,
  });
  if (error) throw new ControlPlaneError("The answer could not be saved.", 503);
}

export async function decideIdentityMatch(
  taskId: string,
  decision: "proposed" | "accepted" | "rejected",
): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_decide_identity_match", {
    p_task_id: taskId,
    p_decision: decision,
  });
  if (error) throw new ControlPlaneError("The match decision could not be saved.", 503);
}

export async function listConversations(limit = 30): Promise<readonly ConversationSummary[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_list_conversations", {
    p_limit: Math.max(1, Math.min(100, Math.trunc(limit))),
  });
  if (error) throw new ControlPlaneError("Conversation history could not be loaded.", 503);
  const parsed = z.array(conversationSummarySchema).safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Conversation history returned invalid state.", 503);
  return Object.freeze(parsed.data);
}

export async function loadConversationHistory(
  conversationId: string,
  afterSequence = 0,
): Promise<ConversationHistory> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_conversation_history", {
    p_conversation_id: conversationId,
    p_after_sequence: Math.max(0, Math.trunc(afterSequence)),
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "P0002" ? "Conversation was not found." : "The conversation could not be loaded.",
      error.code === "P0002" ? 404 : 503,
    );
  }
  const parsed = conversationHistorySchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("The conversation returned invalid state.", 503);
  return parsed.data;
}

export async function consumeAlbertRateLimit(
  action: AlbertRateLimitAction,
): Promise<AlbertRateLimitDecision> {
  const policy = ALBERT_RATE_LIMIT_POLICIES[action];
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("consume_albert_rate_limit", {
    p_action: action,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });
  if (error) throw new ControlPlaneError("Request limits could not be verified.", 503);
  const parsed = z.object({
    allowed: z.boolean(),
    retry_after_seconds: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }).safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("Request limits returned invalid state.", 503);
  return Object.freeze({
    allowed: parsed.data.allowed,
    retryAfterSeconds: parsed.data.retry_after_seconds,
    remaining: parsed.data.remaining,
    limit: policy.limit,
  });
}

export class ControlPlaneError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ControlPlaneError";
  }
}
