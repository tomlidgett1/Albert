/**
 * Semantic memory repository: the per-tenant learned vocabulary rules
 * (ADR 0115, migration 0161) as the control plane stores them.
 *
 * Membership-scoped SECURITY DEFINER RPCs, same posture as the business
 * context repository: any active member reads and saves (rules are captured
 * from any member's conversations); hard delete is owner/manager.
 */
import { z } from "zod";
import { requireUser, ControlPlaneError } from "./web-repository.js";
import type { SemanticMemoryRule } from "../../../packages/albert-codex/src/semantic-memory.js";

type SupabaseClient = Awaited<ReturnType<typeof requireUser>>["supabase"];

const bindingSchema = z.object({
  view: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  dimension: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u).optional(),
  value: z.string().trim().min(1).max(240).optional(),
}).strict();

const ruleSchema = z.object({
  ruleId: z.string().min(8).max(60),
  kind: z.enum(["term_binding", "preference"]),
  term: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(3).max(300),
  counterMeaning: z.string().trim().min(3).max(300).nullish(),
  binding: z.unknown().nullish(),
  status: z.enum(["proposed", "confirmed", "retired"]),
  source: z.enum(["albert", "owner"]),
  sourceConversationId: z.string().max(60).nullish(),
  useCount: z.number().int().nonnegative(),
  lastUsedAt: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function toRule(raw: unknown): SemanticMemoryRule | null {
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) return null;
  // A malformed stored binding degrades to an unbound rule instead of
  // discarding the vocabulary itself.
  const binding = bindingSchema.safeParse(parsed.data.binding);
  return Object.freeze({
    ruleId: parsed.data.ruleId,
    kind: parsed.data.kind,
    term: parsed.data.term,
    meaning: parsed.data.meaning,
    ...(parsed.data.counterMeaning ? { counterMeaning: parsed.data.counterMeaning } : {}),
    ...(binding.success ? { binding: binding.data } : {}),
    status: parsed.data.status,
    source: parsed.data.source,
    useCount: parsed.data.useCount,
    createdAt: parsed.data.createdAt,
    updatedAt: parsed.data.updatedAt,
    lastUsedAt: parsed.data.lastUsedAt ?? null,
    sourceConversationId: parsed.data.sourceConversationId ?? null,
  });
}

/** Every rule for the caller's tenant, retired ones included, newest first. */
export async function loadSemanticMemory(supabaseClient?: SupabaseClient): Promise<readonly SemanticMemoryRule[]> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_semantic_memory");
  if (error) throw new ControlPlaneError("Albert's learned rules could not be loaded.", 503);
  if (!Array.isArray(data)) return [];
  return data.map(toRule).filter((rule): rule is SemanticMemoryRule => rule !== null);
}

export type SaveSemanticRuleInput = Readonly<{
  kind: "term_binding" | "preference";
  term: string;
  meaning: string;
  counterMeaning?: string | null;
  binding?: Readonly<{ view: string; dimension?: string; value?: string }> | null;
  status: "proposed" | "confirmed";
  source: "albert" | "owner";
  conversationId?: string | null;
  turnId?: string | null;
}>;

export async function saveSemanticRule(input: SaveSemanticRuleInput, supabaseClient?: SupabaseClient): Promise<SemanticMemoryRule> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_save_semantic_rule", {
    p_kind: input.kind,
    p_term: input.term,
    p_meaning: input.meaning,
    p_counter_meaning: input.counterMeaning ?? null,
    p_binding: input.binding ?? null,
    p_status: input.status,
    p_source: input.source,
    p_conversation_id: input.conversationId ?? null,
    p_turn_id: input.turnId ?? null,
  });
  if (error) {
    const status = /no active organisation/iu.test(error.message) ? 403 : /200 learned rules/iu.test(error.message) ? 409 : 503;
    throw new ControlPlaneError(
      status === 409 ? "This organisation already holds 200 learned rules; retire one first." : "The learned rule could not be saved.",
      status,
    );
  }
  const rule = toRule(data);
  if (!rule) throw new ControlPlaneError("The learned rule could not be saved.", 503);
  return rule;
}

export async function updateSemanticRuleStatus(
  ruleId: string,
  status: "proposed" | "confirmed" | "retired",
  supabaseClient?: SupabaseClient,
): Promise<SemanticMemoryRule> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_update_semantic_rule_status", {
    p_rule_id: ruleId,
    p_status: status,
  });
  if (error) {
    const status_ = /no such learned rule/iu.test(error.message) ? 404 : /no active organisation/iu.test(error.message) ? 403 : 503;
    throw new ControlPlaneError(status_ === 404 ? "That learned rule no longer exists." : "The learned rule could not be updated.", status_);
  }
  const rule = toRule(data);
  if (!rule) throw new ControlPlaneError("The learned rule could not be updated.", 503);
  return rule;
}

export async function deleteSemanticRule(ruleId: string, supabaseClient?: SupabaseClient): Promise<void> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { error } = await supabase.rpc("albert_delete_semantic_rule", { p_rule_id: ruleId });
  if (error) {
    const status = /insufficient role/iu.test(error.message) ? 403 : 503;
    throw new ControlPlaneError(
      status === 403 ? "Only owners and managers can delete learned rules; retiring is available to everyone." : "The learned rule could not be deleted.",
      status,
    );
  }
}

/** Best-effort usage bookkeeping when rules are injected into a turn. */
export async function recordSemanticRuleUse(ruleIds: readonly string[], supabaseClient?: SupabaseClient): Promise<void> {
  if (ruleIds.length === 0) return;
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  await supabase.rpc("albert_record_semantic_rule_use", { p_rule_ids: [...ruleIds] });
}
