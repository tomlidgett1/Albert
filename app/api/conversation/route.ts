import { z } from "zod";
import { normalizeAgentPreferences } from "@/packages/shared/src";
import { createFixtureConversationSseResponse } from "@/services/conversation/src";
import { createClient } from "@/utils/supabase/server";

const conversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
});

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

/**
 * Authenticated SSE boundary for a conversation turn.
 *
 * The current route deliberately mounts Albert's deterministic governed fixture.
 * Production OpenAI execution remains disabled until the AU inference decision
 * and deployed semantic tool services are available; setting a key alone cannot
 * bypass that control.
 */
export async function POST(request: Request) {
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > 32_000) return jsonError("Request body is too large.", 413);

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return jsonError("Authentication is required.", 401);
  } catch {
    return jsonError("The authenticated conversation service is not configured.", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.", 400);
  }

  const parsed = conversationRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("A valid message is required.", 400);

  const preferences = normalizeAgentPreferences(parsed.data.preferences);
  const configuredRuntime = process.env.ALBERT_CONVERSATION_RUNTIME ?? "fixture";

  if (configuredRuntime !== "fixture") {
    return jsonError(
      "Live model execution is awaiting the approved regional endpoint and semantic services.",
      503,
    );
  }

  const response = createFixtureConversationSseResponse({
    intervalMs: 260,
    signal: request.signal,
  });
  response.headers.set("X-Albert-Runtime", "fixture");
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Albert-Reasoning", preferences.reasoningEffort);
  response.headers.set("X-Albert-Fast-Mode", String(preferences.fastMode));
  return response;
}
