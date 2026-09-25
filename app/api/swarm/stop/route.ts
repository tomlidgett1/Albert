import { z } from "zod";
import { stopSwarmRun } from "@/services/control-plane/src/swarm-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { failConversationTurn } from "@/services/conversation/src/artifact-store";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-swarm-web");
const bodySchema = z.object({
  runId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "Create your organisation before using Swarm." }, {
        status: 409,
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const run = await stopSwarmRun(parsed.runId);
    await failConversationTurn({
      conversationId: run.parentConversationId,
      turnId: run.parentTurnId,
      failureCode: "albert_swarm_stopped",
      supabase: auth.supabase,
    }).catch(() => undefined);
    return Response.json({ run }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json({ error: "Invalid swarm stop request." }, {
        status: 400,
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    logger.error("swarm.stop_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json({
      error: error instanceof ControlPlaneError ? error.message : "The swarm could not be stopped.",
    }, {
      status,
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  }
}
