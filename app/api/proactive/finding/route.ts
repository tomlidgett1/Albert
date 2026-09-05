/**
 * Record a Proactive agent's lifecycle (ADR 0113).
 *
 * POST { runId, agentKey, action } where action is:
 *   "started"   + conversationId/turnId — the agent's codex turn began;
 *   "completed" + answerState/answer/followUps — server-side distillation of
 *                 the answer into headline + key numbers, then persistence;
 *   "failed"    + optional failureNote.
 */
import { z } from "zod";
import { distillProactiveAnswer } from "@/services/proactive/src/distill";
import { proactiveAgentByKey } from "@/services/proactive/src/roster";
import {
  proactiveAnswerStateSchema,
  recordProactiveAgentCompleted,
  recordProactiveAgentFailed,
  recordProactiveAgentStarted,
} from "@/services/control-plane/src/proactive-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-proactive-web");

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
    answerState: proactiveAnswerStateSchema,
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

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Proactive.", 409, correlationId);
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    if (!proactiveAgentByKey(parsed.agentKey)) {
      return jsonError("Unknown proactive agent.", 400, correlationId);
    }

    if (parsed.action === "started") {
      const finding = await recordProactiveAgentStarted({
        runId: parsed.runId,
        agentKey: parsed.agentKey,
        conversationId: parsed.conversationId,
        turnId: parsed.turnId,
      });
      return Response.json({ finding }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }

    if (parsed.action === "completed") {
      const distilled = distillProactiveAnswer(parsed.answer);
      const finding = await recordProactiveAgentCompleted({
        runId: parsed.runId,
        agentKey: parsed.agentKey,
        answerState: parsed.answerState,
        headline: distilled.headline,
        summary: parsed.answer,
        keyNumbers: distilled.keyNumbers,
        questions: parsed.followUps,
      });
      return Response.json({ finding }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }

    const finding = await recordProactiveAgentFailed({
      runId: parsed.runId,
      agentKey: parsed.agentKey,
      ...(parsed.failureNote ? { failureNote: parsed.failureNote } : {}),
    });
    return Response.json({ finding }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid proactive finding request.", 400, correlationId);
    logger.error("proactive.finding_record_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "The proactive finding could not be saved.";
    return jsonError(message, status, correlationId);
  }
}
