import { ControlPlaneError, loadConversationHistory } from "@/services/control-plane/src/web-repository";

const conversationIdPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await context.params;
  const rawAfter = new URL(request.url).searchParams.get("after");
  const after = rawAfter === null ? 0 : Number(rawAfter);
  if (!conversationIdPattern.test(conversationId) || !Number.isInteger(after) || after < 0) {
    return Response.json({ error: "Conversation request is invalid." }, { status: 400 });
  }
  try {
    return Response.json({ history: await loadConversationHistory(conversationId, after) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "The conversation is unavailable." }, { status: 503 });
  }
}
