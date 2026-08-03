import { z } from "zod";
import { consumeAlbertRateLimit, ControlPlaneError, disconnectConnection } from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";

const schema = z.object({ connectionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) });

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    const parsed = schema.safeParse(await readBoundedJsonBody(request));
    if (!parsed.success) return Response.json({ error: "A valid connection is required." }, { status: 400 });
    const rateLimit = await consumeAlbertRateLimit("oauth.disconnect");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
    const result = await disconnectConnection(parsed.data.connectionId);
    return Response.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof ControlPlaneError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "The connection could not be disconnected safely." }, { status: 503 });
  }
}
