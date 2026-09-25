import { z } from "zod";

import { ControlPlaneError, requireUser } from "./web-repository.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const proactiveAnswerStateSchema = z.enum([
  "Verified",
  "Qualified",
  "Exploratory",
  "Clarification",
  "No data",
  "Unavailable",
]);

export const proactiveKeyNumberSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(200),
}).strict();

export const proactiveFindingSchema = z.object({
  findingId: ulidSchema,
  agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
  agentTitle: z.string().min(1).max(120),
  agentTagline: z.string().max(240),
  sequence: z.number().int().min(1).max(24),
  status: z.enum(["pending", "running", "completed", "failed"]),
  conversationId: ulidSchema.nullable(),
  turnId: ulidSchema.nullable(),
  answerState: proactiveAnswerStateSchema.nullable(),
  headline: z.string().max(300).nullable(),
  summary: z.string().max(8_000).nullable(),
  keyNumbers: z.array(proactiveKeyNumberSchema).max(8).catch([]),
  questions: z.array(z.string().max(200)).max(6).catch([]),
  failureNote: z.string().max(300).nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
}).strict();

export const proactiveSynthesisHighlightSchema = z.object({
  agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
  tone: z.enum(["good", "attention", "opportunity"]),
  headline: z.string().min(1).max(160),
  why: z.string().min(1).max(240),
  question: z.string().min(1).max(180),
}).strict();

export const proactiveStoredSynthesisSchema = z.object({
  verdict: z.string().min(1).max(700),
  highlights: z.array(proactiveSynthesisHighlightSchema).min(1).max(5),
  quietLine: z.string().min(1).max(280),
}).strict();

export const proactiveRunSchema = z.object({
  runId: ulidSchema,
  status: z.enum(["running", "completed", "failed", "abandoned"]),
  agentCount: z.number().int().min(1).max(24),
  model: z.string().min(1).max(120),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  synthesis: proactiveStoredSynthesisSchema.nullable().catch(null),
  findings: z.array(proactiveFindingSchema).max(24),
}).strict();

export const proactiveQuestionSchema = z.object({
  text: z.string().min(1).max(200),
  category: z.string().min(1).max(40),
}).strict();

export const proactiveQuestionBankSchema = z.object({
  questions: z.array(proactiveQuestionSchema).max(60),
  generatedAt: z.string(),
}).strict();

export const proactivePanelSchema = z.object({
  run: proactiveRunSchema.nullable(),
  questionBank: proactiveQuestionBankSchema.nullable().catch(null),
  conversationIds: z.array(ulidSchema).max(400),
}).strict();

export type ProactiveFinding = z.infer<typeof proactiveFindingSchema>;
export type ProactiveRun = z.infer<typeof proactiveRunSchema>;
export type ProactivePanel = z.infer<typeof proactivePanelSchema>;

function parseFinding(data: unknown): ProactiveFinding {
  const parsed = proactiveFindingSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The proactive finding returned invalid state.", 503);
  }
  return parsed.data;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new ControlPlaneError(`Proactive research could not be saved: ${error.message}`, 503);
  }
  return data;
}

export async function loadProactivePanel(): Promise<ProactivePanel> {
  const data = await rpc("albert_proactive_panel", {});
  const parsed = proactivePanelSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The proactive panel returned invalid state.", 503);
  }
  return parsed.data;
}

export async function beginProactiveRun(input: Readonly<{
  runId: string;
  model: string;
  reasoningEffort: string;
  agents: readonly Readonly<{ key: string; title: string; tagline: string }>[];
}>): Promise<ProactiveRun> {
  const data = await rpc("albert_proactive_begin_run", {
    p_run_id: input.runId,
    p_model: input.model,
    p_reasoning_effort: input.reasoningEffort,
    p_agents: input.agents,
  });
  const parsed = proactiveRunSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The proactive run returned invalid state.", 503);
  }
  return parsed.data;
}

export async function recordProactiveAgentStarted(input: Readonly<{
  runId: string;
  agentKey: string;
  conversationId: string;
  turnId: string;
}>): Promise<ProactiveFinding> {
  return parseFinding(await rpc("albert_proactive_agent_started", {
    p_run_id: input.runId,
    p_agent_key: input.agentKey,
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
  }));
}

export async function recordProactiveAgentCompleted(input: Readonly<{
  runId: string;
  agentKey: string;
  answerState: z.infer<typeof proactiveAnswerStateSchema>;
  headline: string;
  summary: string;
  keyNumbers: readonly Readonly<{ label: string; value: string }>[];
  questions: readonly string[];
}>): Promise<ProactiveFinding> {
  return parseFinding(await rpc("albert_proactive_agent_completed", {
    p_run_id: input.runId,
    p_agent_key: input.agentKey,
    p_answer_state: input.answerState,
    p_headline: input.headline,
    p_summary: input.summary,
    p_key_numbers: input.keyNumbers,
    p_questions: input.questions,
  }));
}

export async function recordProactiveSynthesis(input: Readonly<{
  runId: string;
  synthesis: z.infer<typeof proactiveStoredSynthesisSchema>;
}>): Promise<ProactiveRun> {
  const data = await rpc("albert_proactive_record_synthesis", {
    p_run_id: input.runId,
    p_synthesis: input.synthesis,
  });
  const parsed = proactiveRunSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The proactive run returned invalid state.", 503);
  }
  return parsed.data;
}

export async function recordProactiveQuestionBank(input: Readonly<{
  questions: readonly z.infer<typeof proactiveQuestionSchema>[];
  model: string;
}>): Promise<z.infer<typeof proactiveQuestionBankSchema>> {
  const data = await rpc("albert_proactive_record_question_bank", {
    p_questions: input.questions,
    p_model: input.model,
  });
  const parsed = proactiveQuestionBankSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The question bank returned invalid state.", 503);
  }
  return parsed.data;
}

export async function recordProactiveAgentFailed(input: Readonly<{
  runId: string;
  agentKey: string;
  failureNote?: string;
}>): Promise<ProactiveFinding> {
  return parseFinding(await rpc("albert_proactive_agent_failed", {
    p_run_id: input.runId,
    p_agent_key: input.agentKey,
    p_failure_note: input.failureNote ?? null,
  }));
}
