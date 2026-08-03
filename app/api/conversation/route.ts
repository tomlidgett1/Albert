import { ulid } from "ulid";
import { z } from "zod";
import { normalizeAgentPreferences } from "@/packages/shared/src";
import { inspectRuntimeEnvironment } from "@/packages/config/src/env";
import { ALBERT_PREFERENCE_OPTION_IDS } from "@/packages/agent/src/semantic-tools";
import { meterOpenAIUsage, toModelUsageRpcPayload } from "@/packages/usage-metering/src";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";
import {
  createFixtureConversationSseResponse,
  createLiveTraceSseResponse,
  createTraceEmitter,
  appendCurrentUserMessage,
  DurableModelUsageLifecycle,
  runLiveAlbertTurn,
  SemanticServiceClient,
} from "@/services/conversation/src";
import {
  appendConversationEvent,
  beginConversationTurn,
  failConversationTurn,
  loadConversationModelContext,
} from "@/services/conversation/src/artifact-store";
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

const conversationRequestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  confirmedOption: z.object({
    offeredTurnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    optionId: z.enum(ALBERT_PREFERENCE_OPTION_IDS),
  }).strict().optional(),
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

function persistedAnswerState(value:string):"verified"|"qualified"|"exploratory"|"clarification"|"unavailable"{
  const normalized=value.toLowerCase();
  if(normalized==="verified"||normalized==="qualified"||normalized==="exploratory"||normalized==="clarification"||normalized==="unavailable")return normalized;
  throw new Error("The completed answer state is invalid.");
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
    body = await readBoundedJsonBody(request);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 400;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Request body must be valid JSON.";
    return jsonError(message, status, correlationId);
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

  if (process.env.NODE_ENV === "production") {
    const readiness = inspectRuntimeEnvironment("web");
    if (!readiness.ready) {
      logger.error("conversation.production_boundary_invalid", {
        missing: readiness.missing,
        invalid: readiness.invalid,
      }, correlationId);
      return jsonError("Live analytics is not fully configured.", 503, correlationId);
    }
  }

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
      confirmedOption: parsed.data.confirmedOption,
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
    modelContext = appendCurrentUserMessage(
      await loadConversationModelContext(begun.conversationId),
      parsed.data.message,
    );
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
    turnId,
    signal: request.signal,
    run: async (deliver, streamSignal) => {
      const timeoutSignal=AbortSignal.timeout(turnTimeoutMs);
      const agentSignal=AbortSignal.any([streamSignal,timeoutSignal]);
      const semanticClient = new SemanticServiceClient(
        configuration.semanticServiceUrl!,
        configuration.semanticSigningSecret!,
      );
      const usageLifecycle = new DurableModelUsageLifecycle(async (usage, outcome) => {
        await semanticClient.checkpointModelUsage({
          tenantId: tenant.tenant_id,
          actorUserId: user.id,
          conversationId: begun.conversationId,
          turnId,
          providerResponseId: usage.providerResponseId,
          providerUsage: usage.providerUsage,
          metering: toModelUsageRpcPayload(usage.metering),
          outcome,
        });
      });
      let deferredTerminalEvent: Parameters<typeof deliver>[0] | undefined;
      let finalizationAttempted = false;
      const emit = createTraceEmitter({
        persist: (event) => appendConversationEvent({
          conversationId: begun.conversationId,
          turnId,
          event,
        }),
        // Persist the terminal event so the semantic service can bind it into
        // the immutable artefact, but do not expose it until that transaction
        // has succeeded. Progress, tables, and validations remain live.
        deliver: (event) => {
          if (event.type === "answer" || event.type === "clarification") {
            deferredTerminalEvent = event;
            return;
          }
          deliver(event);
        },
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
          confirmedPreference: begun.confirmedPreference,
          abortSignal: agentSignal,
          openaiApiKey: configuration.openaiApiKey!,
          openaiBaseUrl: configuration.openaiBaseUrl!,
          semanticServiceUrl: configuration.semanticServiceUrl!,
          semanticSigningSecret: configuration.semanticSigningSecret!,
          safetyIdentifier: await safetyIdentifier(user.id, configuration.userHashSecret!),
          openaiTracingEnabled: process.env.ALBERT_OPENAI_TRACING_ENABLED === "true",
          onProviderUsage: async (providerUsage, providerResponseId) => {
            const metering = meterOpenAIUsage({
              model: preferences.model,
              fastMode: preferences.fastMode,
              usage: providerUsage,
            });
            await usageLifecycle.providerCompleted({
              providerResponseId,
              providerUsage,
              metering,
            });
          },
          emit,
        });
        const usageCheckpoint = usageLifecycle.checkpoint;
        if (!usageCheckpoint) throw new Error("The completed provider run did not produce durable usage.");
        finalizationAttempted = true;
        const finalization = await semanticClient.finalizeAnswerArtifact({
          tenantId:tenant.tenant_id,
          actorUserId:user.id,
          conversationId: begun.conversationId,
          turnId,
          providerResponseId: result.lastResponseId,
          providerUsage: result.usage,
          answerState: persistedAnswerState(result.answerState),
          turnResultDigest: result.resultDigest,
          metering: toModelUsageRpcPayload(usageCheckpoint.metering),
          queryAuditIds: [...result.queryAuditIds],
        });
        try {
          await usageLifecycle.terminal("answer_finalized");
        } catch (usageOutcomeError) {
          logger.error("conversation.usage_outcome_failed", {
            tenantId: tenant.tenant_id,
            conversationId: begun.conversationId,
            turnId,
            outcome: "answer_finalized",
            ...safeErrorEvidence(usageOutcomeError),
          }, correlationId);
        }
        if (!deferredTerminalEvent) {
          throw new Error("The finalized turn did not produce a terminal trace event.");
        }
        deliver(deferredTerminalEvent);
        logger.info("conversation.turn_completed", {
          tenantId: tenant.tenant_id,
          conversationId: begun.conversationId,
          turnId,
          answerState: result.answerState,
          model: preferences.model,
          answerArtifactId: finalization.answerArtifactId,
          artifactDigest: finalization.artifactDigest,
        }, correlationId);
      } catch (error) {
        const disconnected = streamSignal.aborted;
        const timedOut=timeoutSignal.aborted&&!disconnected;
        const usageOutcome = disconnected
          ? "client_disconnected"
          : timedOut
            ? "turn_timeout"
            : finalizationAttempted
              ? "artifact_finalization_failed"
              : "runtime_failure";
        logger.error(disconnected ? "conversation.turn_disconnected" : timedOut ? "conversation.turn_timed_out" : "conversation.turn_failed", {
          tenantId: tenant.tenant_id,
          conversationId: begun.conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        try {
          await usageLifecycle.terminal(usageOutcome).catch((usageError) => {
            logger.error("conversation.usage_failure_outcome_failed", {
              tenantId: tenant.tenant_id,
              conversationId: begun.conversationId,
              turnId,
              outcome: usageOutcome,
              ...safeErrorEvidence(usageError),
            }, correlationId);
          });
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
