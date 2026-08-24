/**
 * Record a Swarm agent's lifecycle (ADR 0120).
 *
 * POST { runId, agentKey, action } where action is:
 *   "started"   + conversationId/turnId
 *   "completed" + answerState/answer/followUps
 *   "failed"    + optional failureNote
 */
import { z } from "zod";
import { distillProactiveAnswer } from "@/services/proactive/src/distill";
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
import { renewConversationTurnLease } from "@/services/conversation/src/artifact-store";
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

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Swarm.", 409, correlationId);
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));

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
