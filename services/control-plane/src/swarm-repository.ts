import { z } from "zod";

import { ControlPlaneError, requireUser } from "./web-repository.js";

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const swarmAnswerStateSchema = z.enum([
  "Verified",
  "Derived",
  "Qualified",
  "Exploratory",
  "Clarification",
  "No data",
  "Unavailable",
]);

export const swarmKeyNumberSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.string().min(1).max(200),
}).strict();

export const swarmAgentSchema = z.object({
  agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
  title: z.string().min(1).max(120),
  tagline: z.string().max(240),
  role: z.enum(["measure", "explain", "challenge", "reconcile"]),
  assignment: z.string().min(1).max(800),
  exclude: z.string().max(800),
  prompt: z.string().min(1).max(4_000),
  sequence: z.number().int().min(1).max(5),
  status: z.enum(["pending", "running", "completed", "failed", "stopped"]),
  conversationId: ulidSchema.nullable(),
  turnId: ulidSchema.nullable(),
  answerState: swarmAnswerStateSchema.nullable(),
  headline: z.string().max(300).nullable(),
  summary: z.string().max(8_000).nullable(),
  keyNumbers: z.array(swarmKeyNumberSchema).max(8).catch([]),
  questions: z.array(z.string().max(200)).max(6).catch([]),
  failureNote: z.string().max(300).nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
}).strict();

export const swarmStoredSynthesisSchema = z.object({
  headline: z.string().min(1).max(160),
  answer: z.string().min(1).max(4_000),
  answerState: z.enum(["Derived", "Exploratory", "No data", "Unavailable"]),
  followUps: z.array(z.string().max(180)).max(4),
  disagreements: z.array(z.string().max(200)).max(4).catch([]),
  source: z.enum(["model", "model-repaired", "fallback"]).optional(),
  unsupportedFigures: z.array(z.string().max(80)).max(8).optional(),
}).strict();

export const swarmPlanPeriodSchema = z.object({
  start: z.string().min(1).max(10),
  end: z.string().min(1).max(10),
  compareStart: z.string().min(1).max(10),
  compareEnd: z.string().min(1).max(10),
}).passthrough();

export const swarmPlanDocumentSchema = z.object({
  periodLabel: z.string().min(1).max(80),
  rationale: z.string().max(280).catch(""),
  period: swarmPlanPeriodSchema.nullable().catch(null).optional(),
  source: z.enum(["model", "fallback"]).optional(),
  periodSource: z.enum(["model", "fallback", "none"]).optional(),
  issue: z.string().max(200).nullable().optional(),
  kind: z.enum(["question", "sales-deep"]).optional(),
}).passthrough();

export const swarmRunSchema = z.object({
  runId: ulidSchema,
  parentConversationId: ulidSchema,
  parentTurnId: ulidSchema,
  question: z.string().min(1).max(8_000),
  status: z.enum(["running", "synthesising", "completed", "failed", "stopped", "abandoned"]),
  agentCount: z.number().int().min(2).max(5),
  model: z.string().min(1).max(120),
  reasoningEffort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]),
  plan: swarmPlanDocumentSchema.catch({ periodLabel: "As asked", rationale: "" }),
  synthesis: swarmStoredSynthesisSchema.nullable().catch(null),
  briefingMarkdown: z.string().max(100_000).nullable().optional(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  agents: z.array(swarmAgentSchema).max(5),
}).strict();

export const swarmPanelSchema = z.object({
  run: swarmRunSchema.nullable(),
  conversationIds: z.array(ulidSchema).max(400),
}).strict();

export type SwarmAgent = z.infer<typeof swarmAgentSchema>;
export type SwarmRun = z.infer<typeof swarmRunSchema>;
export type SwarmPanel = z.infer<typeof swarmPanelSchema>;
export type SwarmStoredSynthesis = z.infer<typeof swarmStoredSynthesisSchema>;

function parseAgent(data: unknown): SwarmAgent {
  const parsed = swarmAgentSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The swarm agent returned invalid state.", 503);
  }
  return parsed.data;
}

function parseRun(data: unknown): SwarmRun {
  const parsed = swarmRunSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The swarm run returned invalid state.", 503);
  }
  return parsed.data;
}

async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    throw new ControlPlaneError(`Swarm could not be saved: ${error.message}`, 503);
  }
  return data;
}

export async function loadSwarmPanel(): Promise<SwarmPanel> {
  const data = await rpc("albert_swarm_panel", {});
  const parsed = swarmPanelSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The swarm panel returned invalid state.", 503);
  }
  return parsed.data;
}

export async function loadSwarmForConversation(conversationId: string): Promise<SwarmPanel> {
  const data = await rpc("albert_swarm_for_conversation", {
    p_conversation_id: conversationId,
  });
  const parsed = swarmPanelSchema.safeParse(data);
  if (!parsed.success) {
    throw new ControlPlaneError("The swarm panel returned invalid state.", 503);
  }
  return parsed.data;
}

export async function loadSwarmRun(runId: string): Promise<SwarmRun> {
  return parseRun(await rpc("albert_swarm_get_run", { p_run_id: runId }));
}

export async function beginSwarmRun(input: Readonly<{
  runId: string;
  parentConversationId: string;
  parentTurnId: string;
  question: string;
  model: string;
  reasoningEffort: string;
  plan: Readonly<{
    periodLabel: string;
    rationale: string;
    period: Readonly<{ start: string; end: string; compareStart: string; compareEnd: string }> | null;
    source: "model" | "fallback";
    periodSource: "model" | "fallback" | "none";
    issue: string | null;
    kind?: "question" | "sales-deep";
  }>;
  agents: readonly Readonly<{
    key: string;
    title: string;
    tagline: string;
    role: string;
    assignment: string;
    exclude: string;
    prompt: string;
  }>[];
}>): Promise<SwarmRun> {
  return parseRun(await rpc("albert_swarm_begin_run", {
    p_run_id: input.runId,
    p_parent_conversation_id: input.parentConversationId,
    p_parent_turn_id: input.parentTurnId,
    p_question: input.question,
    p_model: input.model,
    p_reasoning_effort: input.reasoningEffort,
    p_plan: input.plan,
    p_agents: input.agents,
  }));
}

export async function recordSwarmAgentStarted(input: Readonly<{
  runId: string;
  agentKey: string;
  conversationId: string;
  turnId: string;
}>): Promise<SwarmAgent> {
  return parseAgent(await rpc("albert_swarm_agent_started", {
    p_run_id: input.runId,
    p_agent_key: input.agentKey,
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
  }));
}

export async function recordSwarmAgentCompleted(input: Readonly<{
  runId: string;
  agentKey: string;
  answerState: z.infer<typeof swarmAnswerStateSchema>;
  headline: string;
  summary: string;
  keyNumbers: readonly Readonly<{ label: string; value: string }>[];
  questions: readonly string[];
}>): Promise<SwarmAgent> {
  return parseAgent(await rpc("albert_swarm_agent_completed", {
    p_run_id: input.runId,
    p_agent_key: input.agentKey,
    p_answer_state: input.answerState,
    p_headline: input.headline,
    p_summary: input.summary,
    p_key_numbers: input.keyNumbers,
    p_questions: input.questions,
  }));
}

export async function recordSwarmAgentFailed(input: Readonly<{
  runId: string;
  agentKey: string;
  failureNote?: string;
}>): Promise<SwarmAgent> {
  return parseAgent(await rpc("albert_swarm_agent_failed", {
    p_run_id: input.runId,
    p_agent_key: input.agentKey,
    p_failure_note: input.failureNote ?? null,
  }));
}

export async function recordSwarmSynthesis(input: Readonly<{
  runId: string;
  synthesis: SwarmStoredSynthesis;
}>): Promise<SwarmRun> {
  return parseRun(await rpc("albert_swarm_record_synthesis", {
    p_run_id: input.runId,
    p_synthesis: input.synthesis,
  }));
}

export async function stopSwarmRun(runId: string): Promise<SwarmRun> {
  return parseRun(await rpc("albert_swarm_stop", { p_run_id: runId }));
}

export async function saveSwarmBriefing(input: Readonly<{
  runId: string;
  briefing: string;
}>): Promise<SwarmRun> {
  return parseRun(await rpc("albert_swarm_save_briefing", {
    p_run_id: input.runId,
    p_briefing: input.briefing,
  }));
}

export async function loadLatestSalesBriefing(): Promise<string | null> {
  const data = await rpc("albert_swarm_latest_briefing", {});
  return typeof data === "string" && data.trim() ? data : null;
}
