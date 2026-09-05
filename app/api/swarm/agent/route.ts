/**
 * Record a Swarm agent's lifecycle (ADR 0120).
 *
 * POST { runId, agentKey, action } where action is:
 *   "started"   + conversationId/turnId
 *   "completed" + answerState/answer/followUps
 *   "failed"    + optional failureNote
 *   "recover"   — re-read the child's persisted answer after a broken relay
 *
 * "recover" exists because a child turn outlives its browser stream: the
 * server keeps executing on a client disconnect and persists the answer on
 * the child's own conversation. The orchestrator polls this action instead
 * of recording a false failure; while the child turn is still running the
 * response is { pending: true }.
 */
import { z } from "zod";
import { distillProactiveAnswer } from "@/services/proactive/src/distill";
import {
  swarmChildAnswerFromHistory,
  swarmChildTurnStatusFromHistory,
} from "@/services/swarm/src/child-answers";
import {
  loadSwarmRun,
  recordSwarmAgentCompleted,
  recordSwarmAgentFailed,
  recordSwarmAgentStarted,
  swarmAnswerStateSchema,
} from "@/services/control-plane/src/swarm-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  renewConversationTurnLease,
  type ConversationSupabase,
} from "@/services/conversation/src/artifact-store";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-swarm-web");
const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("started"),
    runId: ulidSchema,
    agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
    conversationId: ulidSchema,
    turnId: ulidSchema,
  }).strict(),
  z.object({
    action: z.literal("completed"),
    runId: ulidSchema,
    agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
    answerState: swarmAnswerStateSchema,
    answer: z.string().min(1).max(8_000),
    followUps: z.array(z.string().min(1).max(200)).max(6).default([]),
  }).strict(),
  z.object({
    action: z.literal("failed"),
    runId: ulidSchema,
    agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
    failureNote: z.string().max(300).optional(),
  }).strict(),
  z.object({
    action: z.literal("recover"),
    runId: ulidSchema,
    agentKey: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
  }).strict(),
]);

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

async function renewParentLease(runId: string): Promise<void> {
  const run = await loadSwarmRun(runId);
  const { supabase } = await requireUser();
  await renewConversationTurnLease({
    supabase,
    turnId: run.parentTurnId,
    leaseSeconds: 360,
  });
}

/**
 * The same persisted-transcript read synthesis recovery uses: the child's
 * own conversation is the truth, the browser relay only a copy of it.
 */
async function recoverAgentFromChildTurn(
  supabase: ConversationSupabase,
  input: Readonly<{ runId: string; agentKey: string }>,
): Promise<Readonly<{ agent: unknown; recovered: boolean; pending: boolean }>> {
  const run = await loadSwarmRun(input.runId);
  const agent = run.agents.find((entry) => entry.agentKey === input.agentKey);
  if (!agent) throw new ControlPlaneError("The swarm agent is unknown.", 404);
  if (agent.status === "completed") return { agent, recovered: true, pending: false };
  if (!agent.conversationId || !agent.turnId || agent.status === "stopped") {
    return { agent, recovered: false, pending: false };
  }
  const { data, error } = await supabase.rpc("albert_conversation_history", {
    p_conversation_id: agent.conversationId,
    p_after_sequence: 0,
  });
  if (error) throw new ControlPlaneError("The child conversation could not be read.", 503);
  const history = Array.isArray(data) ? data[0] ?? null : data;
  const answer = swarmChildAnswerFromHistory(history, agent.turnId);
  if (!answer) {
    // A running child turn may still land its answer; a settled one without
    // an answer event has nothing left to recover.
    const turnStatus = swarmChildTurnStatusFromHistory(history, agent.turnId);
    return { agent, recovered: false, pending: turnStatus === "running" };
  }
  const distilled = distillProactiveAnswer(answer.text);
  const parsedState = swarmAnswerStateSchema.safeParse(answer.answerState);
  const updated = await recordSwarmAgentCompleted({
    runId: input.runId,
    agentKey: input.agentKey,
    answerState: parsedState.success ? parsedState.data : "Exploratory",
    headline: distilled.headline,
    summary: answer.text.slice(0, 8_000),
    keyNumbers: distilled.keyNumbers,
    questions: answer.followUps.map((question) => question.slice(0, 200)),
  });
  return { agent: updated, recovered: true, pending: false };
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Swarm.", 409, correlationId);
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));

    if (parsed.action === "recover") {
      const result = await recoverAgentFromChildTurn(auth.supabase, {
        runId: parsed.runId,
        agentKey: parsed.agentKey,
      });
      if (result.recovered) {
        logger.info("swarm.agent_recovered", {
          tenantId: tenant.tenant_id,
          runId: parsed.runId,
          agentKey: parsed.agentKey,
          source: "orchestrator-poll",
        }, correlationId);
      }
      await renewParentLease(parsed.runId).catch(() => undefined);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }

    if (parsed.action === "started") {
      const agent = await recordSwarmAgentStarted({
        runId: parsed.runId,
        agentKey: parsed.agentKey,
        conversationId: parsed.conversationId,
        turnId: parsed.turnId,
      });
      await renewParentLease(parsed.runId).catch(() => undefined);
      return Response.json({ agent }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }

    if (parsed.action === "completed") {
      const distilled = distillProactiveAnswer(parsed.answer);
      const agent = await recordSwarmAgentCompleted({
        runId: parsed.runId,
        agentKey: parsed.agentKey,
        answerState: parsed.answerState,
        headline: distilled.headline,
        summary: parsed.answer,
        keyNumbers: distilled.keyNumbers,
        questions: parsed.followUps,
      });
      await renewParentLease(parsed.runId).catch(() => undefined);
      return Response.json({ agent }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }

    const agent = await recordSwarmAgentFailed({
      runId: parsed.runId,
      agentKey: parsed.agentKey,
      ...(parsed.failureNote ? { failureNote: parsed.failureNote } : {}),
    });
    await renewParentLease(parsed.runId).catch(() => undefined);
    return Response.json({ agent }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid swarm agent request.", 400, correlationId);
    logger.error("swarm.agent_record_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The swarm agent could not be saved.",
      status,
      correlationId,
    );
  }
}
