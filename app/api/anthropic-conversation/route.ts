import { ulid } from "ulid";
import { z } from "zod";
import {
  ANTHROPIC_FALLBACK_MODEL,
  ANTHROPIC_PRIMARY_MODEL,
  ANTHROPIC_RUNTIME,
  ANTHROPIC_SDK_VERSION,
  AnthropicSemanticClient,
  anthropicConversationRequestSchema,
  internalCompletionSchema,
} from "@/packages/anthropic-analytics/src";
import { assertOrderedSanitizedTrace, type TraceEvent } from "@/packages/shared/src";
import { signInternalRequest } from "@/packages/security/src";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

const begunTurnSchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  confirmed_preference: z.string().nullable().optional(),
  confirmed_value: z.string().nullable().optional(),
}).passthrough();

function singleton(value: unknown): unknown {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function encodeTrace(event: TraceEvent): string {
  return `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`;
}

function unavailableTrace(turnId: string, sequence: number, reason: string): TraceEvent {
  return {
    id: `anthropic_${turnId}_${sequence}`,
    sequence,
    type: "answer",
    status: "warning",
    occurredAt: new Date().toISOString(),
    state: "Unavailable",
    text: `I couldn't produce a grounded result for this request. ${reason.slice(0, 500)}`,
    provenance: {
      sources: [],
      timeRange: { label: "Requested period", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "unavailable",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    },
    followUps: ["Try a narrower question or a shorter reporting period."],
    presentedResultIds: [],
    claims: [],
  };
}

async function terminalUnavailableResponse(input: Readonly<{
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"];
  conversationId: string;
  turnId: string;
  reason: string;
}>): Promise<Response> {
  const event = unavailableTrace(input.turnId, 1, input.reason);
  await Promise.resolve(input.supabase.rpc("albert_answer_event_append", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_event: event,
  })).catch(() => undefined);
  await Promise.resolve(input.supabase.rpc("fail_albert_turn", {
    p_conversation_id: input.conversationId,
    p_turn_id: input.turnId,
    p_failure_code: "anthropic_service_unavailable",
  })).catch(() => undefined);
  return new Response(encodeTrace(event), {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Albert-Runtime": "anthropic",
      "X-Albert-Conversation-Id": input.conversationId,
      "X-Albert-Turn-Id": input.turnId,
    },
  });
}

function parseSseBlock(block: string): Readonly<{ event: string; data: string }> | null {
  const lines = block.split("\n");
  const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  return data ? { event, data } : null;
}

async function assertAnthropicConversation(
  supabase: Awaited<ReturnType<typeof requireUser>>["supabase"],
  conversationId: string,
): Promise<void> {
  const { data, error } = await supabase.rpc("albert_conversation_history", {
    p_conversation_id: conversationId,
    p_after_sequence: 0,
  });
  if (error) throw new ControlPlaneError("The conversation could not be loaded.", error.code === "P0002" ? 404 : 503);
  const history = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  const turns = Array.isArray(history?.turns) ? history.turns : [];
  const last = turns.at(-1);
  const profile = last && typeof last === "object" && !Array.isArray(last)
    ? (last as Record<string, unknown>).runtime_profile
    : null;
  const runtime = profile && typeof profile === "object" && !Array.isArray(profile)
    ? (profile as Record<string, unknown>).runtime
    : null;
  const model = profile && typeof profile === "object" && !Array.isArray(profile)
    ? (profile as Record<string, unknown>).model
    : null;
  if (runtime !== ANTHROPIC_RUNTIME && !(typeof model === "string" && model.startsWith("claude-"))) {
    throw new ControlPlaneError("This conversation belongs to a different analytics method. Start a New Method conversation instead.", 409);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Request rejected.", error instanceof ControlPlaneError ? error.status : 403);
  }

  let auth: Awaited<ReturnType<typeof requireUser>>;
  let tenant: Awaited<ReturnType<typeof currentTenantContext>>;
  try {
    auth = await requireUser();
    tenant = await currentTenantContext();
    if (!tenant) return errorResponse("Create your organisation before starting a conversation.", 409);
    const rateLimit = await consumeAlbertRateLimit("conversation.turn");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Authentication is unavailable.", error instanceof ControlPlaneError ? error.status : 503);
  }

  const serviceUrl = process.env.ANTHROPIC_ANALYTICS_SERVICE_URL?.trim();
  const serviceSecret = process.env.ALBERT_ANTHROPIC_SIGNING_SECRET?.trim();
  const semanticUrl = process.env.SEMANTIC_QUERY_SERVICE_URL?.trim();
  const semanticSecret = process.env.ALBERT_SEMANTIC_SIGNING_SECRET?.trim();
  if (!serviceUrl || !serviceSecret || !semanticUrl || !semanticSecret || serviceSecret.length < 32 || semanticSecret.length < 32) {
    return errorResponse("New Method analytics is not fully configured.", 503);
  }

  let parsed;
  try {
    parsed = anthropicConversationRequestSchema.parse(await readBoundedJsonBody(request));
    if (parsed.conversationId) await assertAnthropicConversation(auth.supabase, parsed.conversationId);
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "A valid message is required.", error instanceof ControlPlaneError ? error.status : 400);
  }

  const turnId = ulid();
  const { data: begunData, error: beginError } = await auth.supabase.rpc("begin_albert_turn", {
    p_conversation_id: parsed.conversationId ?? null,
    p_turn_id: turnId,
    p_user_message: parsed.message,
    p_runtime_profile: {
      provider: "anthropic",
      runtime: ANTHROPIC_RUNTIME,
      sdkVersion: ANTHROPIC_SDK_VERSION,
      model: ANTHROPIC_PRIMARY_MODEL,
      fallbackModel: ANTHROPIC_FALLBACK_MODEL,
      reasoningEffort: "max",
      fastMode: false,
    },
    p_confirmation_turn_id: parsed.confirmedOption?.offeredTurnId ?? null,
    p_confirmation_option_id: parsed.confirmedOption?.optionId ?? null,
  });
  if (beginError) return errorResponse("The New Method conversation could not be started.", beginError.code === "23514" ? 409 : 503);
  const begun = begunTurnSchema.safeParse(singleton(begunData));
  if (!begun.success) return errorResponse("The New Method conversation returned invalid state.", 503);
  const conversationId = begun.data.conversation_id;

  const internalBody = JSON.stringify({
    tenantId: tenant.tenant_id,
    actorUserId: auth.user.id,
    role: tenant.role,
    conversationId,
    turnId,
    message: parsed.message,
    ...(begun.data.confirmed_preference && begun.data.confirmed_value ? {
      confirmedPreference: begun.data.confirmed_preference,
      confirmedValue: begun.data.confirmed_value,
    } : {}),
  });
  const path = "/v1/turns";
  const signature = await signInternalRequest({ method: "POST", path, body: internalBody, secret: serviceSecret });
  let upstream: Response;
  try {
    upstream = await fetch(new URL(path, serviceUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signature },
      body: internalBody,
      signal: request.signal,
    });
  } catch {
    return terminalUnavailableResponse({
      supabase: auth.supabase,
      conversationId,
      turnId,
      reason: "New Method analytics is temporarily unavailable.",
    });
  }
  if (!upstream.ok || !upstream.body) {
    const payload = await upstream.json().catch(() => null) as { error?: { message?: string } } | null;
    return terminalUnavailableResponse({
      supabase: auth.supabase,
      conversationId,
      turnId,
      reason: payload?.error?.message ?? "New Method analytics could not start.",
    });
  }

  const semanticClient = new AnthropicSemanticClient(semanticUrl, semanticSecret);
  const encoder = new TextEncoder();
  const reader = upstream.body.getReader();
  const persisted: TraceEvent[] = [];
  const persist = async (event: TraceEvent) => {
    assertOrderedSanitizedTrace([...persisted, event]);
    const { error } = await auth.supabase.rpc("albert_answer_event_append", {
      p_conversation_id: conversationId,
      p_turn_id: turnId,
      p_event: event,
    });
    if (error) throw new Error("The New Method trace could not be persisted.");
    persisted.push(event);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed && !request.signal.aborted) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        controller.close();
      };
      const emit = (value: string) => {
        if (!closed && !request.signal.aborted) controller.enqueue(encoder.encode(value));
      };
      const fail = async (reason: string) => {
        const event = unavailableTrace(turnId, persisted.length + 1, reason);
        await persist(event).catch(() => undefined);
        await Promise.resolve(auth.supabase.rpc("fail_albert_turn", {
          p_conversation_id: conversationId,
          p_turn_id: turnId,
          p_failure_code: "anthropic_runtime_failure",
        })).catch(() => undefined);
        emit(encodeTrace(event));
      };
      void (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        let completed = false;
        try {
          while (true) {
            const { value, done } = await reader.read();
            buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const frame = parseSseBlock(block);
              if (frame?.event === "trace") {
                const event = JSON.parse(frame.data) as TraceEvent;
                await persist(event);
                emit(encodeTrace(event));
              } else if (frame?.event === "albert_internal_completion") {
                const completion = internalCompletionSchema.parse(JSON.parse(frame.data));
                const terminalEvent = completion.terminalEvent as unknown as TraceEvent;
                await persist(terminalEvent);
                await semanticClient.finalize({
                  provider: "anthropic",
                  tenantId: tenant.tenant_id,
                  actorUserId: auth.user.id,
                  conversationId,
                  turnId,
                  providerResponseId: completion.providerResponseId,
                  providerUsage: completion.providerUsage,
                  answerState: completion.answerState,
                  turnResultDigest: completion.turnResultDigest,
                  metering: completion.metering,
                  queryAuditIds: completion.queryAuditIds,
                }, request.signal);
                emit(encodeTrace(terminalEvent));
                completed = true;
              } else if (frame?.event === "albert_internal_failure") {
                throw new Error("The Anthropic analytics runtime failed safely.");
              }
              boundary = buffer.indexOf("\n\n");
            }
            if (done) break;
          }
          if (!completed) throw new Error("The Anthropic analytics runtime ended without a terminal result.");
        } catch (error) {
          if (!request.signal.aborted) await fail(error instanceof Error ? error.message : "New Method analytics failed safely.");
        } finally {
          reader.releaseLock();
          close();
        }
      })();
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => undefined);
      const event = unavailableTrace(turnId, persisted.length + 1, "This analysis was cancelled before it completed.");
      void persist(event)
        .catch(() => undefined)
        .then(() => Promise.resolve(auth.supabase.rpc("fail_albert_turn", {
          p_conversation_id: conversationId,
          p_turn_id: turnId,
          p_failure_code: "client_disconnected",
        })))
        .catch(() => undefined);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Albert-Runtime": "anthropic",
      "X-Albert-Conversation-Id": conversationId,
      "X-Albert-Turn-Id": turnId,
    },
  });
}
