import { ControlPlaneError, loadTurnAnswerLineage } from "@/services/control-plane/src/web-repository";

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string; turnId: string }> },
) {
  const { conversationId, turnId } = await context.params;
  if (!ulidPattern.test(conversationId) || !ulidPattern.test(turnId)) {
    return Response.json({ error: "Answer lineage request is invalid." }, { status: 400 });
  }
  try {
    return Response.json({ lineage: await loadTurnAnswerLineage(conversationId, turnId) }, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Answer lineage is unavailable." }, { status: 503 });
  }
}
