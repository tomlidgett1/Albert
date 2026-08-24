/**
 * Synthesise the parent Swarm answer (ADR 0120).
 *
 * POST { runId }. Reads only persisted findings. Appends the answer to the
 * parent turn and releases the parent lease.
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import { buildSwarmSynthesis, conservativeSwarmAnswerState } from "@/services/swarm/src/synthesis";
import { swarmParentAnswerEvent, swarmPlanSteps } from "@/services/swarm/src/parent-events";
import {
  loadSwarmRun,
  recordSwarmSynthesis,
} from "@/services/control-plane/src/swarm-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  appendConversationEvent,
  failConversationTurn,
} from "@/services/conversation/src/artifact-store";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

export const maxDuration = 120;

const logger = createServiceLogger("albert-swarm-web");

const bodySchema = z.object({
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Swarm.", 409, correlationId);
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return jsonError("Swarm is not configured on this environment.", 503, correlationId);

    const run = await loadSwarmRun(parsed.runId);
    if (run.synthesis) {
      return Response.json({
        synthesis: run.synthesis,
        conversationId: run.parentConversationId,
        turnId: run.parentTurnId,
      }, { headers: { "Cache-Control": "no-store", "x-request-id": correlationId } });
    }

    const stillOpen = run.agents.some((agent) => (
      agent.status === "pending" || agent.status === "running"
    ));
    if (stillOpen) {
      return jsonError("Specialists are still working.", 409, correlationId);
    }

    const completed = run.agents.filter((agent) => agent.status === "completed");
    if (completed.length === 0) {
      await failConversationTurn({
        conversationId: run.parentConversationId,
        turnId: run.parentTurnId,
        failureCode: "albert_swarm_failed",
        supabase: auth.supabase,
      }).catch(() => undefined);
      return jsonError("No specialist finished, so there is nothing to combine.", 409, correlationId);
    }

    const findings = run.agents.map((agent) => ({
      agentKey: agent.agentKey,
      title: agent.title,
      role: agent.role,
      answerState: agent.answerState,
      headline: agent.headline,
      keyNumbers: agent.keyNumbers,
      summaryExcerpt: agent.summary ?? "",
      failed: agent.status === "failed" || agent.status === "stopped",
      failureNote: agent.failureNote,
    }));
    const synthesis = await buildSwarmSynthesis({
      question: run.question,
      periodLabel: run.plan.periodLabel,
      businessName: tenant.tenant_name ?? "the business",
      findings,
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      safetyIdentifier: createHash("sha256")
        .update(`${tenant.tenant_id}:${auth.user.id}`)
        .digest("hex"),
      signal: request.signal,
    });
    const answerState = conservativeSwarmAnswerState(findings);
    const stored = await recordSwarmSynthesis({
      runId: run.runId,
      synthesis: {
        headline: synthesis.headline,
        answer: synthesis.answer,
        answerState,
        followUps: synthesis.followUps,
        disagreements: synthesis.disagreements,
      },
    });

    await appendConversationEvent({
      conversationId: run.parentConversationId,
      turnId: run.parentTurnId,
      supabase: auth.supabase,
      event: {
        id: ulid(),
        sequence: 3,
        occurredAt: new Date().toISOString(),
        type: "plan",
        steps: swarmPlanSteps({
          agents: run.agents.map((agent) => ({
            key: agent.agentKey,
            title: agent.title,
            status: agent.status,
          })),
          synthesised: true,
        }),
      },
    }).catch(() => undefined);
    await appendConversationEvent({
      conversationId: run.parentConversationId,
      turnId: run.parentTurnId,
      supabase: auth.supabase,
      event: swarmParentAnswerEvent({
        id: ulid(),
        sequence: 4,
        occurredAt: new Date().toISOString(),
        answer: synthesis.answer,
        answerState,
        followUps: synthesis.followUps,
        timezone: tenant.timezone,
      }),
    }).catch(() => undefined);
    await failConversationTurn({
      conversationId: run.parentConversationId,
      turnId: run.parentTurnId,
      failureCode: answerState === "Unavailable" ? "albert_swarm_unavailable" : "albert_swarm_answered",
      supabase: auth.supabase,
    }).catch(() => undefined);

    logger.info("swarm.synthesis_recorded", {
      tenantId: tenant.tenant_id,
      runId: run.runId,
      answerState,
      completedAgents: completed.length,
    }, correlationId);

    return Response.json({
      synthesis: stored.synthesis ?? {
        headline: synthesis.headline,
        answer: synthesis.answer,
        answerState,
        followUps: synthesis.followUps,
        disagreements: synthesis.disagreements,
      },
      conversationId: run.parentConversationId,
      turnId: run.parentTurnId,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": correlationId } });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid swarm synthesis request.", 400, correlationId);
    logger.error("swarm.synthesis_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The swarm answer could not be written.",
      status,
      correlationId,
    );
  }
}
