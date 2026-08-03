import { ControlPlaneError, listConversations } from "@/services/control-plane/src/web-repository";

export async function GET(request: Request) {
  const rawLimit = new URL(request.url).searchParams.get("limit");
  const limit = rawLimit === null ? 30 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return Response.json({ error: "Limit must be an integer between 1 and 100." }, { status: 400 });
  }
  try {
    return Response.json({ conversations: await listConversations(limit) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Conversation history is unavailable." }, { status: 503 });
  }
}
