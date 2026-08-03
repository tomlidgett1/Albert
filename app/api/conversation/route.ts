import { ulid } from "ulid";
import { z } from "zod";
import { normalizeAgentPreferences } from "@/packages/shared/src";
import { meterOpenAIUsage } from "@/packages/usage-metering/src";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";
import {
  createFixtureConversationSseResponse,
  createLiveTraceSseResponse,
  createTraceEmitter,
  runLiveAlbertTurn,
} from "@/services/conversation/src";
import {
  appendConversationEvent,
  beginConversationTurn,
  completeConversationTurn,
  failConversationTurn,
  loadConversationModelContext,
  recordConversationModelUsage,
} from "@/services/conversation/src/artifact-store";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

const conversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  confirmedChoice: z.object({
    question: z.string().trim().min(1).max(300),
    value: z.string().trim().min(1).max(300),
  }).optional(),
});

const logger = createServiceLogger("albert-web");

function jsonError(
  message: string,
  status: number,
  correlationId: string,
  details?: Readonly<Record<string, unknown>>,
) {
  return Response.json(
    { error: message, ...details },
    { status, headers: { "x-request-id": correlationId } },
  );
}

function turnTimeoutMilliseconds():number{
  const parsed=Number(process.env.ALBERT_TURN_TIMEOUT_MS??180_000);
  if(!Number.isInteger(parsed)||parsed<30_000||parsed>300_000){
    throw new Error("ALBERT_TURN_TIMEOUT_MS must be between 30000 and 300000.");
  }
  return parsed;
}

async function safetyIdentifier(userId: string, secret: string): Promise<string> {
  const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {name:"HMAC",hash:"SHA-256"},
    false,
    ["sign"],
  );
  const digest=await crypto.subtle.sign("HMAC",key,encoder.encode(userId));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 403;
    logger.warn("conversation.request_rejected", { status, ...safeErrorEvidence(error) }, correlationId);
    return jsonError(error instanceof Error ? error.message : "Request rejected.", status, correlationId);
  }
  const declaredSize = Number(request.headers.get("content-length") ?? 0);
  if (declaredSize > 32_000) return jsonError("Request body is too large.", 413, correlationId);

  let user;
  let tenant;
  try {
    ({ user } = await requireUser());
    tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before starting a conversation.", 409, correlationId);
    const rateLimit = await consumeAlbertRateLimit("conversation.turn");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
  } catch (error) {
    logger.warn("conversation.authentication_failed", safeErrorEvidence(error), correlationId);
    if (error instanceof ControlPlaneError) return jsonError(error.message, error.status, correlationId);
    return jsonError("The authenticated conversation service is unavailable.", 503, correlationId);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Request body must be valid JSON.", 400, correlationId);
  }
  const parsed = conversationRequestSchema.safeParse(body);
  if (!parsed.success) return jsonError("A valid message is required.", 400, correlationId);

  const preferences = normalizeAgentPreferences(parsed.data.preferences);
  const configuredRuntime = process.env.ALBERT_CONVERSATION_RUNTIME ?? "live";
  if (configuredRuntime === "fixture") {
    if (process.env.NODE_ENV === "production" || process.env.ALBERT_ALLOW_FIXTURE_RUNTIME !== "true") {
      return jsonError("Fixture analytics are disabled outside explicit local development.", 503, correlationId);
    }
    const response = createFixtureConversationSseResponse({ intervalMs: 260, signal: request.signal });
    response.headers.set("X-Albert-Runtime", "fixture");
    return response;
  }
  if (configuredRuntime !== "live") return jsonError("Unknown conversation runtime configuration.", 503, correlationId);

  const configuration = {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiBaseUrl: process.env.OPENAI_BASE_URL,
    semanticServiceUrl: process.env.SEMANTIC_QUERY_SERVICE_URL,
    semanticSigningSecret: process.env.ALBERT_SEMANTIC_SIGNING_SECRET,
    userHashSecret: process.env.ALBERT_USER_HASH_SECRET,
  };
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.error("conversation.configuration_missing", { missing }, correlationId);
    return jsonError("Live analytics is not fully configured.", 503, correlationId);
  }
  let turnTimeoutMs:number;
  try{turnTimeoutMs=turnTimeoutMilliseconds();}
  catch(error){
    logger.error("conversation.configuration_invalid", safeErrorEvidence(error), correlationId);
    return jsonError("Live analytics has an invalid timeout configuration.",503,correlationId);
  }

  const turnId = ulid();
  let begun;
  try {
    begun = await beginConversationTurn({
      conversationId: parsed.data.conversationId,
      turnId,
      message: parsed.data.message,
      runtimeProfile: {
        model: preferences.model,
        reasoningEffort: preferences.reasoningEffort,
        fastMode: preferences.fastMode,
        runtime: "openai-agents-sdk",
      },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof Error ? error.message : "The conversation could not be started.";
    logger.error("conversation.turn_begin_failed", { status, ...safeErrorEvidence(error) }, correlationId);
    return jsonError(message, status, correlationId);
  }

  logger.info("conversation.turn_started", {
    tenantId: tenant.tenant_id,
    conversationId: begun.conversationId,
    turnId,
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort,
    fastMode: preferences.fastMode,
  }, correlationId);

  let modelContext;
  try {
    modelContext = await loadConversationModelContext(begun.conversationId);
  } catch (error) {
    await failConversationTurn({
      conversationId: begun.conversationId,
      turnId,
      failureCode: "context_unavailable",
    }).catch(() => undefined);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("conversation.context_failed", {
      conversationId: begun.conversationId,
      turnId,
      ...safeErrorEvidence(error),
    }, correlationId);
    return jsonError(error instanceof Error ? error.message : "The conversation context is unavailable.", status, correlationId);
  }

  const response = createLiveTraceSseResponse({
    conversationId: begun.conversationId,
    signal: request.signal,
    run: async (deliver, streamSignal) => {
      const timeoutSignal=AbortSignal.timeout(turnTimeoutMs);
      const agentSignal=AbortSignal.any([streamSignal,timeoutSignal]);
      const emit = createTraceEmitter({
        persist: (event) => appendConversationEvent({
          conversationId: begun.conversationId,
          turnId,
          event,
        }),
        deliver,
      });
      try {
        const result = await runLiveAlbertTurn({
          message: parsed.data.message,
          preferences,
          tenantId: tenant.tenant_id,
          role: tenant.role,
          conversationId: begun.conversationId,
          turnId,
          modelContext,
          confirmedChoice: parsed.data.confirmedChoice,
          abortSignal: agentSignal,
          openaiApiKey: configuration.openaiApiKey!,
          openaiBaseUrl: configuration.openaiBaseUrl!,
          semanticServiceUrl: configuration.semanticServiceUrl!,
          semanticSigningSecret: configuration.semanticSigningSecret!,
          safetyIdentifier: await safetyIdentifier(user.id, configuration.userHashSecret!),
          openaiTracingEnabled: process.env.ALBERT_OPENAI_TRACING_ENABLED === "true",
          emit,
        });
        const metering = meterOpenAIUsage({
          model: preferences.model,
          fastMode: preferences.fastMode,
          usage: result.usage as Parameters<typeof meterOpenAIUsage>[0]["usage"],
        });
        await recordConversationModelUsage({
          conversationId: begun.conversationId,
          turnId,
          metering,
        });
        await completeConversationTurn({
          conversationId: begun.conversationId,
          turnId,
          providerResponseId: result.lastResponseId,
          usage: result.usage,
          answerState: result.answerState,
          resultDigest: result.resultDigest,
        });
        logger.info("conversation.turn_completed", {
          tenantId: tenant.tenant_id,
          conversationId: begun.conversationId,
          turnId,
          answerState: result.answerState,
          model: preferences.model,
        }, correlationId);
      } catch (error) {
        const disconnected = streamSignal.aborted;
        const timedOut=timeoutSignal.aborted&&!disconnected;
        logger.error(disconnected ? "conversation.turn_disconnected" : timedOut ? "conversation.turn_timed_out" : "conversation.turn_failed", {
          tenantId: tenant.tenant_id,
          conversationId: begun.conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        try {
          if (!disconnected) {
            await emit({
              type: "error",
              status: "error",
              message: timedOut
                ? "Albert reached the safe analysis time limit. The partial trace was recorded and the turn can be retried."
                : "Albert could not complete the governed analysis. The failed step was recorded and can be retried safely.",
              recoverable: true,
            });
          }
          await failConversationTurn({
            conversationId: begun.conversationId,
            turnId,
            failureCode: disconnected ? "client_disconnected" : timedOut ? "turn_timeout" : "runtime_failure",
          });
        } catch (finalizeError) {
          logger.error("conversation.turn_finalize_failed", {
            tenantId: tenant.tenant_id,
            conversationId: begun.conversationId,
            turnId,
            ...safeErrorEvidence(finalizeError),
          }, correlationId);
        }
      }
    },
  });
  response.headers.set("X-Albert-Runtime", "openai");
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Albert-Reasoning", preferences.reasoningEffort);
  response.headers.set("X-Albert-Fast-Mode", String(preferences.fastMode));
  response.headers.set("X-Request-Id", correlationId);
  return response;
}
