import { z } from "zod";
import { rewindConversationFromTurn } from "@/services/conversation/src/artifact-store";
import {
  ControlPlaneError,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";

const conversationIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const rewindBodySchema = z.object({
  fromTurnId: z.string().regex(conversationIdPattern),
}).strict();

const logger = createServiceLogger("albert-web");

export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Request origin is invalid." }, { status: 403 });
  }

  const { conversationId } = await context.params;
  if (!conversationIdPattern.test(conversationId)) {
    return Response.json({ error: "Conversation request is invalid." }, { status: 400 });
  }

  try {
    const { supabase } = await requireUser();
    const body = rewindBodySchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) {
      return Response.json({ error: "Rewind request is invalid." }, { status: 400 });
    }
    const result = await rewindConversationFromTurn({
      conversationId,
      fromTurnId: body.data.fromTurnId,
      supabase,
    });
    return Response.json({
      conversationId: result.conversationId,
      fromTurnId: result.fromTurnId,
      fromTurnNumber: result.fromTurnNumber,
      hiddenTurnCount: result.hiddenTurnCount,
      failedRunningCount: result.failedRunningCount,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    logger.warn("conversation.rewind_failed", {
      conversationId,
      ...safeErrorEvidence(error),
    }, correlationId);
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, {
        status: error.status,
        headers: { "x-request-id": correlationId },
      });
    }
    return Response.json({ error: "The conversation could not be rewound." }, {
      status: 503,
      headers: { "x-request-id": correlationId },
    });
  }
}
