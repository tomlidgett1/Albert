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
  generateConversationTitle,
  runLiveAlbertTurn,
  SemanticServiceClient,
} from "@/services/conversation/src";
import {
  appendConversationEvent,
  assignConversationTitle,
  beginConversationTurn,
  conversationNeedsTitle,
  failConversationTurn,
  loadConversationModelContext,
  renewConversationTurnLease,
} from "@/services/conversation/src/artifact-store";
import { SemanticServiceError } from "@/services/conversation/src/semantic-client";
import type { SemanticToolResponse } from "@/packages/agent/src/semantic-tools";
import type { TraceEvent } from "@/packages/shared/src";
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

function isSemanticUnreachable(error: unknown): boolean {
  // Only treat true transport failures as unreachable. Application 5xx codes
  // from the semantic service (for example SEMANTIC_TOOL_ERROR) must surface so
  // soft stubs do not hide a live but failing tool path.
  if (error instanceof SemanticServiceError) {
    return error.status === 502 || error.status === 504;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network|The operation was aborted|TimeoutError/i.test(message);
}

function unavailableSemanticToolResponse(toolName: string, input: unknown): SemanticToolResponse {
  const topic = input && typeof input === "object" && "topic" in input && typeof (input as { topic?: unknown }).topic === "string"
    ? (input as { topic: string }).topic
    : "unknown";
  const domain = input && typeof input === "object" && "domain" in input && typeof (input as { domain?: unknown }).domain === "string"
    ? (input as { domain: string }).domain
    : topic;
  const emptyProvenance = {
    bundleHash: "sha256:unavailable-local-semantic",
    registryVersion: "unavailable",
    identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
    sources: [] as string[],
    sourceWatermarks: {} as Record<string, string>,
    sourceDetails: [] as [],
    definitionsApplied: [] as string[],
    definitionDetails: [] as [],
  };
  const blocked = {
    status: "blocked" as const,
    checks: [{ name: "semantic_service", outcome: "failed", detail: "Governed analytics service is unavailable." }],
    warnings: ["Connected analytical data is not reachable yet. Albert cannot invent figures."],
  };
  const performance = { cacheHit: false, durationMs: 0, rowCount: 0 };
  if (toolName === "get_capabilities") {
    return {
      state: "unavailable",
      capabilities: {
        topic,
        answerable: false,
        required: [`topic:${topic}`],
        available: [],
        missing: [`topic:${topic}`, "semantic_service"],
        details: [],
      },
      provenance: emptyProvenance,
      validation: blocked,
      performance,
    };
  }
  if (toolName === "get_data_health") {
    return {
      state: "unavailable",
      dataHealth: {
        domain,
        status: "blocked",
        checks: [{ name: "semantic_service", outcome: "failed" }],
        warnings: ["Analytical readiness cannot be checked until the governed query service and synced data are available."],
      },
      provenance: emptyProvenance,
      validation: blocked,
      performance,
    };
  }
  if (toolName === "search_catalogue") {
    return {
      state: "unavailable",
      catalogue: {
        topics: [],
        metrics: [],
        dimensions: [],
        fields: [],
        tenantContext: { defaults: {}, dossier: {} },
      },
      provenance: emptyProvenance,
      validation: blocked,
      performance,
    };
  }
  if (toolName === "get_definition") {
    return {
      state: "unavailable",
      definition: {
        unavailable: true,
        reason: "Governed definitions are unavailable until the analytical query service is reachable.",
      },
      provenance: emptyProvenance,
      validation: blocked,
      performance,
    };
  }
  if (toolName === "list_field_values") {
    return {
      state: "unavailable",
      fieldValues: [],
      provenance: emptyProvenance,
      validation: blocked,
      performance,
    };
  }
  if (toolName === "remember") {
    return {
      state: "unavailable",
      rememberedPreference: { preference: "unavailable", overlayVersion: 1 },
      provenance: emptyProvenance,
      validation: blocked,
      performance,
    };
  }
  return {
    state: "unavailable",
    provenance: emptyProvenance,
    validation: blocked,
    performance,
  };
}

/**
 * An analytical turn runs until it finishes or the client disconnects. A wall
 * clock is the wrong instrument here: a thorough multi-query answer legitimately
 * takes longer than a single lookup, and cutting one off mid-run destroyed the
 * work rather than shortening it. Set ALBERT_TURN_TIMEOUT_MS only to impose a
 * deliberate ceiling; leaving it unset means no deadline.
 */
/** Renew well inside the 6-minute durable lease so one slow call cannot lapse it. */
const LEASE_RENEWAL_INTERVAL_MS=120_000;

function turnTimeoutMilliseconds():number|undefined{
  const configured=process.env.ALBERT_TURN_TIMEOUT_MS;
  if(configured===undefined||configured.trim()==="")return undefined;
  const parsed=Number(configured);
  if(!Number.isInteger(parsed)||parsed<30_000){
    throw new Error("ALBERT_TURN_TIMEOUT_MS must be an integer of at least 30000 milliseconds.");
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
  let supabase;
  try {
    ({ user, supabase } = await requireUser());
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
  let turnTimeoutMs:number|undefined;
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
      supabase,
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
      await loadConversationModelContext(begun.conversationId, supabase),
      parsed.data.message,
    );
  } catch (error) {
    await failConversationTurn({
      conversationId: begun.conversationId,
      turnId,
      failureCode: "context_unavailable",
      supabase,
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
    run: async (stream, streamSignal) => {
      const deliver = stream.emit;
      const timeoutSignal=turnTimeoutMs===undefined?undefined:AbortSignal.timeout(turnTimeoutMs);
      const agentSignal=timeoutSignal===undefined
        ? streamSignal
        : AbortSignal.any([streamSignal,timeoutSignal]);
      // Hold the durable lease open for as long as this runner is alive. The
      // reaper recovers turns whose process died; it must not reclaim one that
      // is still working, which is what an unbounded turn would otherwise hit.
      const leaseRenewal=setInterval(()=>{
        void renewConversationTurnLease({supabase,turnId}).catch(()=>undefined);
      },LEASE_RENEWAL_INTERVAL_MS);
      // Title generation is intentionally off the analytical critical path:
      // cheapest nano model, fire-and-forget, first title wins in the DB.
      void (async () => {
        try {
          if (!await conversationNeedsTitle(begun.conversationId, supabase)) return;
          const title = await generateConversationTitle({
            question: parsed.data.message,
            apiKey: configuration.openaiApiKey!,
            baseUrl: configuration.openaiBaseUrl!,
            signal: streamSignal,
          });
          if (!title || streamSignal.aborted) return;
          const assignment = await assignConversationTitle({
            conversationId: begun.conversationId,
            title,
            supabase,
          });
          if (assignment.assigned) stream.emitConversationTitle(assignment.title);
        } catch (error) {
          logger.warn("conversation.title_generation_failed", {
            conversationId: begun.conversationId,
            turnId,
            ...safeErrorEvidence(error),
          }, correlationId);
        }
      })();
      const semanticClient = new SemanticServiceClient(
        configuration.semanticServiceUrl!,
        configuration.semanticSigningSecret!,
      );
      const resilientSemantic = {
        execute: async (
          name: Parameters<SemanticServiceClient["execute"]>[0],
          input: unknown,
          context: Parameters<SemanticServiceClient["execute"]>[2],
        ) => {
          try {
            return await semanticClient.execute(name, input, context);
          } catch (error) {
            if (!isSemanticUnreachable(error)) throw error;
            logger.warn("conversation.semantic_tool_unavailable", {
              tool: name,
              ...safeErrorEvidence(error),
            }, correlationId);
            return unavailableSemanticToolResponse(name, input);
          }
        },
      };
      const usageLifecycle = new DurableModelUsageLifecycle(async (usage, outcome) => {
        try {
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
        } catch (error) {
          if (!isSemanticUnreachable(error)) throw error;
          logger.warn("conversation.usage_checkpoint_unavailable", {
            outcome,
            ...safeErrorEvidence(error),
          }, correlationId);
        }
      });
      let deferredTerminalEvent: TraceEvent | undefined;
      let finalizationAttempted = false;
      const emit = createTraceEmitter({
        persist: (event) => appendConversationEvent({
          conversationId: begun.conversationId,
          turnId,
          event,
          supabase,
        }),
        // The event has already reached the browser by the time a queued write
        // fails, so this is the only place the loss becomes visible.
        onPersistError: (error, event) => {
          logger.warn("conversation.trace_event_persist_failed", {
            tenantId: tenant.tenant_id,
            conversationId: begun.conversationId,
            turnId,
            eventType: event.type,
            eventSequence: event.sequence,
            ...safeErrorEvidence(error),
          }, correlationId);
        },
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
          semanticClient: resilientSemantic,
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
        try {
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
            ...(result.directoryEvidence ? { directoryEvidence: result.directoryEvidence } : {}),
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
        } catch (finalizationError) {
          // Without a local semantic cell, still stream the Unavailable answer
          // so the UI is never left empty. Authenticated clients cannot call
          // complete_albert_turn; release the lease instead.
          if (!isSemanticUnreachable(finalizationError) || !deferredTerminalEvent) {
            throw finalizationError;
          }
          logger.warn("conversation.answer_finalization_unavailable", {
            tenantId: tenant.tenant_id,
            conversationId: begun.conversationId,
            turnId,
            answerState: result.answerState,
            ...safeErrorEvidence(finalizationError),
          }, correlationId);
          try {
            await usageLifecycle.terminal("artifact_finalization_failed");
          } catch (usageOutcomeError) {
            logger.error("conversation.usage_outcome_failed", {
              tenantId: tenant.tenant_id,
              conversationId: begun.conversationId,
              turnId,
              outcome: "artifact_finalization_failed",
              ...safeErrorEvidence(usageOutcomeError),
            }, correlationId);
          }
          deliver(deferredTerminalEvent);
          await failConversationTurn({
            conversationId: begun.conversationId,
            turnId,
            failureCode: "artifact_finalization_failed",
            supabase,
          });
        }
      } catch (error) {
        const disconnected = streamSignal.aborted;
        const timedOut=Boolean(timeoutSignal?.aborted)&&!disconnected;
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
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "unknown",
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
            try {
              await emit({
                type: "error",
                status: "error",
                message: timedOut
                  ? "Albert reached the analysis time limit. The partial trace was recorded and the turn can be retried."
                  : "Sorry, Albert could not finish that answer. The failed step was recorded and can be retried safely.",
                recoverable: true,
              });
            } catch {
              deliver({
                id: ulid(),
                sequence: 1,
                type: "error",
                status: "error",
                occurredAt: new Date().toISOString(),
                message: timedOut
                  ? "Albert reached the analysis time limit. The partial trace was recorded and the turn can be retried."
                  : (error instanceof Error ? error.message.slice(0, 400) : "Sorry, Albert could not finish that answer."),
                recoverable: true,
              });
            }
          }
          // Flush the partial trace and the error event above before the turn
          // is marked failed, so the recorded failure is backed by the steps
          // that led to it rather than by whatever happened to be written.
          await emit.drain?.();
          await failConversationTurn({
            conversationId: begun.conversationId,
            turnId,
            failureCode: disconnected ? "client_disconnected" : timedOut ? "turn_timeout" : "runtime_failure",
            supabase,
          });
        } catch (finalizeError) {
          logger.error("conversation.turn_finalize_failed", {
            tenantId: tenant.tenant_id,
            conversationId: begun.conversationId,
            turnId,
            ...safeErrorEvidence(finalizeError),
            errorMessage: finalizeError instanceof Error ? finalizeError.message.slice(0, 500) : "unknown",
          }, correlationId);
        }
      } finally {
        clearInterval(leaseRenewal);
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
