import {
  generateConversationTitle,
} from "@/services/conversation/src";
import {
  assignConversationTitle,
  conversationNeedsTitle,
  loadConversationModelContext,
} from "@/services/conversation/src/artifact-store";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";

const conversationIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;
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
    await requireUser();
    const rateLimit = await consumeAlbertRateLimit("conversation.title");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "The conversation service is unavailable." }, { status: 503 });
  }

  const openaiApiKey = process.env.OPENAI_API_KEY?.trim();
  const openaiBaseUrl = process.env.OPENAI_BASE_URL?.trim();
  if (!openaiApiKey || !openaiBaseUrl) {
    return Response.json({ error: "Live analytics is not fully configured." }, { status: 503 });
  }

  try {
    if (!await conversationNeedsTitle(conversationId)) {
      return Response.json({ assigned: false }, { status: 200, headers: { "Cache-Control": "no-store" } });
    }
    const contextMessages = await loadConversationModelContext(conversationId);
    const question = contextMessages.find((message) => message.role === "user")?.text?.trim();
    if (!question) {
      return Response.json({ error: "No user question is available to title." }, { status: 409 });
    }
    const title = await generateConversationTitle({
      question,
      apiKey: openaiApiKey,
      baseUrl: openaiBaseUrl,
      signal: request.signal,
    });
    if (!title) {
      return Response.json({ error: "A conversation title could not be generated." }, { status: 502 });
    }
    const assignment = await assignConversationTitle({
      conversationId,
      title,
    });
    return Response.json({
      title: assignment.title,
      assigned: assignment.assigned,
    }, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logger.warn("conversation.title_backfill_failed", {
      conversationId,
      ...safeErrorEvidence(error),
    }, correlationId);
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "The conversation title could not be saved." }, { status: 503 });
  }
}
