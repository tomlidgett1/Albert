import { ControlPlaneError, loadAnswerLineage } from "@/services/control-plane/src/web-repository";

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ conversationId: string; artifactId: string }> },
) {
  const { conversationId, artifactId } = await context.params;
  if (!ulidPattern.test(conversationId) || !ulidPattern.test(artifactId)) {
    return Response.json({ error: "Answer lineage request is invalid." }, { status: 400 });
  }
  try {
    const lineage = await loadAnswerLineage(artifactId);
    if (lineage.conversationId !== conversationId) {
      return Response.json({ error: "Answer lineage was not found." }, { status: 404 });
    }
    return Response.json({ lineage }, {
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
