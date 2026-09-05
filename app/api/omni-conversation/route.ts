import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
  ALBERT_OMNI_ANALYTICAL_RUNTIME,
  ALBERT_OMNI_DEFAULT_EFFORT,
  ALBERT_OMNI_DEFAULT_FAST_MODE,
  ALBERT_OMNI_DEFAULT_MODEL,
  ALBERT_OMNI_MODEL_IDS,
  ALBERT_OMNI_PROTOCOL_VERSION,
  ALBERT_OMNI_RUNTIME,
  OmniRuntimeServiceClient,
  OmniRuntimeServiceError,
  omniConversationRequestSchema,
  omniRuntimeServiceUrl,
  omniPriorResults,
  pairDerivedTableEvent,
  type OmniServiceTurn,
  type OmniTraceEventInput,
} from "@/packages/albert-omni/src";
import {
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  codexSocialProvenance,
  codexSocialReply,
  detectCodexSocialMessage,
} from "@/packages/albert-codex/src";
import { signCubeJwt } from "@/packages/albert-v3/src/cube/jwt";
import { isAnthropicModel, normalizeAgentPreferences, providerForModel } from "@/packages/shared/src";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";
import {
  appendConversationEvent,
  assignConversationTitle,
  beginConversationTurn,
  conversationNeedsTitle,
  failConversationTurn,
  loadConversationModelContext,
  loadPriorTurnResults,
  renewConversationTurnLease,
} from "@/services/conversation/src/artifact-store";
import {
  createLiveTraceSseResponse,
  createTraceEmitter,
  directCodexConversationReply,
  generateInitialAcknowledgement,
  generateConversationTitle,
  isClearlyAnalyticalCodexMessage,
  LOW_LATENCY_ACKNOWLEDGEMENT_MAX_OUTPUT_TOKENS,
  LOW_LATENCY_ACKNOWLEDGEMENT_MODEL,
  LOW_LATENCY_ACKNOWLEDGEMENT_REASONING_EFFORT,
  LOW_LATENCY_ACKNOWLEDGEMENT_SERVICE_TIER,
  LOW_LATENCY_ACKNOWLEDGEMENT_TIMEOUT_MS,
  routeCodexMessage,
} from "@/services/conversation/src";
import { loadBusinessContext } from "@/services/control-plane/src/business-context-repository";
import { loadLatestSalesBriefing } from "@/services/control-plane/src/swarm-repository";
import { salesBriefingContextBlock } from "@/services/swarm/src/sales-deep";
import { createSupabaseAnalyticalQueryRecorder } from "@/services/control-plane/src/query-log-repository";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

export const maxDuration = 800;
// This route's function region is pinned to Sydney in vercel.json (the
// `preferredRegion` export is deprecated in Next 16 and ignored): every
// service it talks to (control-plane Supabase, the agent runtime on Fly,
// Cube) lives there, and the platform default put the function in US-east.

const LEASE_RENEWAL_INTERVAL_MS = 120_000;
const logger = createServiceLogger("albert-omni-web");

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": correlationId,
    },
  });
}

function publicOmniFailure(error: unknown): string {
  if (error instanceof OmniRuntimeServiceError) {
    const byCode: Readonly<Record<string, string>> = {
      omni_unavailable: "The Omni runtime is not configured on this environment.",
      omni_runtime_unavailable: "The Omni runtime is unavailable right now.",
      omni_semantic_unavailable: "The governed semantic layer was unavailable.",
      omni_overloaded: "Albert is unusually busy right now. Try again in a minute.",
      omni_cancelled: "The analysis was cancelled before it finished.",
      omni_turn_timeout: "The analysis ran out of time before finishing.",
      omni_turn_budget: "The analysis reached its step budget before finishing.",
      omni_model_rejected: "The model request was rejected by the provider.",
      omni_missing_answer: "The analysis finished without a final answer.",
      replayed_request: "This request was already used. Ask the question again.",
    };
    const mapped = byCode[error.code];
    if (mapped) return mapped;
  }
  const detail = error instanceof Error ? error.message : "";
  if (/Cube|semantic|catalogue/iu.test(detail)) {
    return "The governed semantic layer was unavailable.";
  }
  return "The analysis could not be completed safely.";
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 403;
    return jsonError(error instanceof Error ? error.message : "Request rejected.", status, correlationId);
  }

  let auth: Awaited<ReturnType<typeof requireUser>>;
  let tenant: Awaited<ReturnType<typeof currentTenantContext>>;
  try {
    auth = await requireUser();
    tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before starting a conversation.", 409, correlationId);
    const rateLimit = await consumeAlbertRateLimit("conversation.turn");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
  } catch (error) {
    if (error instanceof ControlPlaneError) return jsonError(error.message, error.status, correlationId);
    return jsonError("Supabase is not connected. Authentication could not be completed.", 503, correlationId);
  }

  let parsed;
  try {
    parsed = omniConversationRequestSchema.parse(await readBoundedJsonBody(request));
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 400;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "A valid message is required.",
      status,
      correlationId,
    );
  }

  const preferences = normalizeAgentPreferences(parsed.preferences ?? {
    model: ALBERT_OMNI_DEFAULT_MODEL,
    reasoningEffort: ALBERT_OMNI_DEFAULT_EFFORT,
    fastMode: ALBERT_OMNI_DEFAULT_FAST_MODE,
  });
  if (!(ALBERT_OMNI_MODEL_IDS as readonly string[]).includes(preferences.model)) {
    return jsonError("Omni supports GPT-5.6 Luna, Terra, Sol, Claude Sonnet 5, and Claude Haiku 4.5 only.", 400, correlationId);
  }
  if (
    isAnthropicModel(preferences.model)
    && process.env.NODE_ENV === "production"
    && (
      process.env.ALBERT_ANTHROPIC_APP8_APPROVED !== "true"
      || process.env.ALBERT_ANTHROPIC_ZDR_APPROVED !== "true"
    )
  ) {
    return jsonError(
      "Claude models are not approved for production data on this Albert environment.",
      503,
      correlationId,
    );
  }
  const reasoningEffort = preferences.reasoningEffort === "none" ? "low" : preferences.reasoningEffort;

  const serviceUrl = omniRuntimeServiceUrl();
  const serviceSigningSecret = process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim()
    || (process.env.NODE_ENV === "production" ? "" : ALBERT_CODEX_LOCAL_SIGNING_SECRET);
  const cubeApiSecret = process.env.CUBEJS_API_SECRET?.trim() ?? "";
  const cubeApiUrl = process.env.CUBE_API_URL?.trim() ?? "";
  if (!cubeApiSecret || !cubeApiUrl || !serviceUrl || !serviceSigningSecret) {
    logger.error("omni.configuration_missing", {
      serviceUrl: Boolean(serviceUrl),
      serviceSigningSecret: Boolean(serviceSigningSecret),
      cubeApiSecret: Boolean(cubeApiSecret),
      cubeApiUrl: Boolean(cubeApiUrl),
    }, correlationId);
    return jsonError("The Omni runtime is not configured on this environment.", 503, correlationId);
  }

  const turnId = ulid();
  const runtimeProfile = {
    provider: providerForModel(preferences.model),
    runtime: ALBERT_OMNI_RUNTIME,
    analyticalRuntime: ALBERT_OMNI_ANALYTICAL_RUNTIME,
    model: preferences.model,
    reasoningEffort,
    fastMode: preferences.fastMode,
    analysisTimeoutMs: ALBERT_OMNI_ANALYSIS_TIMEOUT_MS,
  } as const;

  let begun: Awaited<ReturnType<typeof beginConversationTurn>>;
  try {
    begun = await beginConversationTurn({
      conversationId: parsed.conversationId,
      turnId,
      message: parsed.message,
      runtimeProfile,
      replaceTurnId: parsed.replaceTurnId,
      staleLeaseFailureCode: "albert_omni_stale_lease_released",
      supabase: auth.supabase,
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("omni.turn_begin_failed", { status, ...safeErrorEvidence(error) }, correlationId);
    return jsonError("The Omni conversation could not be started.", status, correlationId);
  }
  const conversationId = begun.conversationId;
  const queryRecorder = createSupabaseAnalyticalQueryRecorder({
    supabase: auth.supabase,
    conversationId,
    turnId,
    correlationId,
  });

  const localConversationResponse = (
    text: string,
    followUps: readonly string[],
    failureCode: string,
  ): Response => {
    const response = createLiveTraceSseResponse({
      conversationId,
      turnId,
      signal: request.signal,
      run: async (stream) => {
        const emit = createTraceEmitter({
          persistenceAttempts: 4,
          requireDurableTerminal: true,
          persist: (event) => appendConversationEvent({
            conversationId,
            turnId,
            event,
            supabase: auth.supabase,
          }),
          deliver: stream.emit,
          onPersistError: (error, event) => logger.warn("omni.local_conversation_trace_persist_failed", {
            conversationId,
            turnId,
            eventType: event.type,
            ...safeErrorEvidence(error),
          }, correlationId),
        });
        try {
          await emit({
            type: "answer",
            status: "complete",
            state: "Verified",
            text,
            provenance: codexSocialProvenance(),
            followUps: [...followUps],
            presentedResultIds: [],
            claims: [],
          });
          await emit.drain?.();
          await failConversationTurn({
            conversationId,
            turnId,
            failureCode,
            supabase: auth.supabase,
          });
        } catch (error) {
          logger.error("omni.local_conversation_turn_failed", safeErrorEvidence(error), correlationId);
          await failConversationTurn({
            conversationId,
            turnId,
            failureCode: "albert_omni_local_conversation_failure",
            supabase: auth.supabase,
          }).catch(() => undefined);
        }
      },
    });
    response.headers.set("X-Albert-Runtime", "omni");
    response.headers.set("X-Albert-Model", preferences.model);
    response.headers.set("X-Request-Id", correlationId);
    return response;
  };

  // A dashboard build is always an analytical turn: its server-composed brief
  // must never be diverted by the social/conversational short-circuits.
  const socialKind = parsed.dashboardBuild ? null : detectCodexSocialMessage(parsed.message);
  if (socialKind) {
    const reply = codexSocialReply(socialKind, parsed.message);
    return localConversationResponse(reply.text, reply.followUps, "albert_omni_social_answered");
  }

  const directConversationReply = parsed.dashboardBuild
    ? null
    : directCodexConversationReply(parsed.message, tenant.timezone);
  if (directConversationReply) {
    return localConversationResponse(directConversationReply, [], "albert_omni_direct_conversation_answered");
  }

  const clearlyAnalytical = Boolean(parsed.dashboardBuild) || isClearlyAnalyticalCodexMessage(
    parsed.message,
    Boolean(parsed.conversationId),
  );
  if (!clearlyAnalytical) {
    const routerApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
    if (routerApiKey) {
      const decision = await routeCodexMessage({
        message: parsed.message,
        hasPriorConversation: Boolean(parsed.conversationId),
        apiKey: routerApiKey,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        timezone: tenant.timezone,
        safetyIdentifier: createHash("sha256")
          .update(`${tenant.tenant_id}:${auth.user.id}`)
          .digest("hex"),
        signal: request.signal,
      }).catch((error) => {
        if (!request.signal.aborted) {
          logger.warn("omni.message_router_failed", safeErrorEvidence(error), correlationId);
        }
        return { route: "analysis" as const, response: null };
      });
      if (decision.route === "conversation" && decision.response) {
        return localConversationResponse(decision.response, [], "albert_omni_routed_conversation_answered");
      }
    }
  }

  const acknowledgementApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const initialAcknowledgement = acknowledgementApiKey
    ? generateInitialAcknowledgement({
        question: parsed.message,
        apiKey: acknowledgementApiKey,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        safetyIdentifier: createHash("sha256")
          .update(`${tenant.tenant_id}:${auth.user.id}`)
          .digest("hex"),
        model: LOW_LATENCY_ACKNOWLEDGEMENT_MODEL,
        reasoningEffort: LOW_LATENCY_ACKNOWLEDGEMENT_REASONING_EFFORT,
        serviceTier: LOW_LATENCY_ACKNOWLEDGEMENT_SERVICE_TIER,
        timeoutMs: LOW_LATENCY_ACKNOWLEDGEMENT_TIMEOUT_MS,
        maxOutputTokens: LOW_LATENCY_ACKNOWLEDGEMENT_MAX_OUTPUT_TOKENS,
        signal: request.signal,
      }).catch((error) => {
        if (!request.signal.aborted) {
          logger.warn("omni.initial_acknowledgement_failed", {
            conversationId,
            turnId,
            ...safeErrorEvidence(error),
          }, correlationId);
        }
        return null;
      })
    : Promise.resolve(null);

  let priorConversation: readonly Readonly<{ role: "user" | "assistant"; text: string }>[];
  let activeConnectors: readonly string[] = [];
  let connectorFreshness: readonly OmniServiceTurn["connectorFreshness"][number][] = [];
  let businessContext: string | undefined;
  let priorResults: NonNullable<OmniServiceTurn["priorResults"]> = [];
  try {
    const [history, routing, context, salesBriefing, reusableResults] = await Promise.all([
      loadConversationModelContext(conversationId, auth.supabase),
      loadConnectorRouting(auth.supabase).catch(() => undefined),
      loadBusinessContext(auth.supabase).catch(() => null),
      // A missing tenant briefing stays missing. A process-wide file cannot
      // establish who owns its contents and must never enter an owner's turn.
      loadLatestSalesBriefing().catch(() => null),
      parsed.dashboardBuild ? Promise.resolve([]) : loadPriorTurnResults(conversationId, auth.supabase).catch(() => []),
    ]);
    priorConversation = history.slice(-12).map(({ role, text }) => ({ role, text: text.slice(0, 24_000) }));
    priorResults = omniPriorResults(reusableResults);
    activeConnectors = routing?.activeConnectors ?? [];
    connectorFreshness = routing?.freshness ?? [];
    const existingContext = context?.rendered.slice(0, 12_000) ?? "";
    const briefingBlock = typeof salesBriefing === "string" && salesBriefing.trim()
      ? salesBriefingContextBlock(salesBriefing)
      : "";
    businessContext = [existingContext, briefingBlock].filter(Boolean).join("\n\n").slice(0, 20_000) || undefined;
  } catch (error) {
    await failConversationTurn({
      conversationId,
      turnId,
      failureCode: "context_unavailable",
      supabase: auth.supabase,
    }).catch(() => undefined);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError("The conversation context is unavailable.", status, correlationId);
  }

  const cubeBearer = signCubeJwt({
    secret: cubeApiSecret,
    expiresInSeconds: 900,
    securityContext: {
      tenant_id: tenant.tenant_id,
      role: tenant.role,
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: conversationId,
      turn_id: turnId,
    },
  });
  const client = new OmniRuntimeServiceClient(serviceUrl, serviceSigningSecret);

  logger.info("omni.turn_started", {
    tenantId: tenant.tenant_id,
    conversationId,
    turnId,
    model: preferences.model,
    transport: "signed-job-poll",
  }, correlationId);

  const response = createLiveTraceSseResponse({
    conversationId,
    turnId,
    signal: request.signal,
    continueOnClientDisconnect: true,
    run: async (stream, streamSignal) => {
      const leaseRenewal = setInterval(() => {
        void renewConversationTurnLease({ supabase: auth.supabase, turnId }).catch(() => undefined);
      }, LEASE_RENEWAL_INTERVAL_MS);
      const emit = createTraceEmitter({
        persistenceAttempts: 4,
        requireDurableTerminal: true,
        persist: (event) => appendConversationEvent({
          conversationId,
          turnId,
          event,
          supabase: auth.supabase,
        }),
        deliver: stream.emit,
        onPersistError: (error, event) => logger.warn("omni.trace_event_persist_failed", {
          conversationId,
          turnId,
          eventType: event.type,
          ...safeErrorEvidence(error),
        }, correlationId),
      });
      void (async () => {
        try {
          if (!await conversationNeedsTitle(conversationId, auth.supabase)) return;
          const apiKey = process.env.OPENAI_API_KEY?.trim();
          if (!apiKey) return;
          const title = await generateConversationTitle({
            question: parsed.message,
            apiKey,
            baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
            signal: streamSignal,
          });
          if (!title || streamSignal.aborted) return;
          const assignment = await assignConversationTitle({ conversationId, title, supabase: auth.supabase });
          if (assignment.assigned) stream.emitConversationTitle(assignment.title);
        } catch (error) {
          logger.warn("omni.title_generation_failed", safeErrorEvidence(error), correlationId);
        }
      })();
      try {
        const ownerName = typeof auth.user.user_metadata?.full_name === "string"
          ? auth.user.user_metadata.full_name.trim().slice(0, 120)
          : undefined;
        const serviceTurn: OmniServiceTurn = {
          protocolVersion: ALBERT_OMNI_PROTOCOL_VERSION,
          requestId: ulid(),
          tenantId: tenant.tenant_id,
          actorId: auth.user.id,
          role: tenant.role,
          conversationId,
          turnId,
          message: parsed.message,
          priorConversation: [...priorConversation],
          priorResults,
          activeConnectors: [...activeConnectors],
          connectorFreshness: [...connectorFreshness],
          ...(businessContext ? { businessContext } : {}),
          timezone: tenant.timezone,
          ...(ownerName ? { ownerName } : {}),
          organisationName: tenant.tenant_name.slice(0, 160),
          cubeBearer,
          model: preferences.model,
          effort: reasoningEffort,
          fastMode: preferences.fastMode,
          ...(parsed.dashboardBuild ? { dashboardBuild: true } : {}),
          ...(parsed.dashboardBuild && parsed.dashboardEdit ? { dashboardEdit: true } : {}),
          ...(parsed.dashboardBuild && parsed.dashboardEdit && parsed.dashboardEditTopic
            ? { dashboardEditTopic: parsed.dashboardEditTopic }
            : {}),
        };
        const bufferedRuntimeEvents: OmniTraceEventInput[] = [];
        let runtimeTraceReleased = false;
        // The runtime cannot know web-stamped event ids, so replayable tables
        // arrive with an empty dashboardReplay.queryEventId and a resultId
        // that pairs them with their query event. The pairing happens here,
        // before the emitter stamps and persists; an unpairable reference is
        // stripped so a broken replay ref can never persist.
        const queryEventIdByResultId = new Map<string, string>();
        const tableEventIdByResultId = new Map<string, string>();
        const deliverRuntimeEvent = async (event: OmniTraceEventInput) => {
          try {
            let outbound = event;
            if (
              outbound.type === "table"
              && outbound.dashboardReplay?.kind === "cube_v3"
              && !outbound.dashboardReplay.queryEventId
            ) {
              const queryEventId = queryEventIdByResultId.get(outbound.resultId);
              if (queryEventId) {
                outbound = {
                  ...outbound,
                  dashboardReplay: { ...outbound.dashboardReplay, queryEventId },
                };
              } else {
                const withoutReplay = { ...outbound };
                delete (withoutReplay as { dashboardReplay?: unknown }).dashboardReplay;
                outbound = withoutReplay;
              }
            }
            if (outbound.type === "table" && outbound.dashboardReplay?.kind === "derived_v1") {
              // A remotely derived table arrives with placeholder source table
              // event ids; pair them from the stamped trace and recompute the
              // transform digest, or strip the recipe entirely.
              const paired = pairDerivedTableEvent(outbound, tableEventIdByResultId);
              if (paired) {
                outbound = { ...outbound, ...paired };
              } else {
                const withoutReplay = { ...outbound };
                delete (withoutReplay as { dashboardReplay?: unknown }).dashboardReplay;
                delete (withoutReplay as { dashboardDerivation?: unknown }).dashboardDerivation;
                outbound = withoutReplay;
              }
            }
            const stamped = await emit(outbound);
            if (stamped.type === "query" && stamped.resultId) {
              queryEventIdByResultId.set(stamped.resultId, stamped.id);
            }
            if (stamped.type === "table" && stamped.resultId) {
              tableEventIdByResultId.set(stamped.resultId, stamped.id);
            }
          } catch (error) {
            logger.error("omni.trace_event_rejected", {
              conversationId,
              turnId,
              eventType: event.type,
              ...safeErrorEvidence(error),
            }, correlationId);
            if (event.type === "answer") throw error;
          }
        };
        const emitRuntimeEvent = async (event: OmniTraceEventInput) => {
          if (!runtimeTraceReleased) {
            bufferedRuntimeEvents.push(event);
            return;
          }
          await deliverRuntimeEvent(event);
        };
        const runtimeOutcome = client.runTurn(
          serviceTurn,
          emitRuntimeEvent,
          streamSignal,
          async (event) => {
            if (event.phase === "start") await queryRecorder.start(event.attempt);
            else await queryRecorder.finish(event.outcome);
          },
        ).then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        const acknowledgement = await initialAcknowledgement;
        if (acknowledgement && !streamSignal.aborted) {
          await emit({
            type: "narrative",
            purpose: "acknowledgement",
            text: acknowledgement.text,
          });
        }
        runtimeTraceReleased = true;
        while (bufferedRuntimeEvents.length > 0) {
          await deliverRuntimeEvent(bufferedRuntimeEvents.shift()!);
        }

        const outcome = await runtimeOutcome;
        if (!outcome.ok) throw outcome.error;
        const result = outcome.result;
        await emit.drain?.();
        await failConversationTurn({
          conversationId,
          turnId,
          failureCode: result.answerState === "Unavailable" ? "albert_omni_unavailable" : "albert_omni_answered",
          supabase: auth.supabase,
        });
        logger.info("omni.turn_completed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          answerState: result.answerState,
          queriesExecuted: result.queriesExecuted,
          modelRequests: result.modelRequests,
          durationMs: result.durationMs,
          ...(result.usage ? { usage: result.usage } : {}),
        }, correlationId);
      } catch (error) {
        const disconnected = streamSignal.aborted;
        logger.error(disconnected ? "omni.turn_disconnected" : "omni.turn_failed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        try {
          if (!disconnected) {
            await emit({
              type: "error",
              status: "error",
              message: publicOmniFailure(error),
              recoverable: true,
            });
          }
          await emit.drain?.();
          await failConversationTurn({
            conversationId,
            turnId,
            failureCode: disconnected ? "client_disconnected" : "omni_runtime_failure",
            supabase: auth.supabase,
          });
        } catch (finalizeError) {
          logger.error("omni.turn_finalize_failed", safeErrorEvidence(finalizeError), correlationId);
        }
      } finally {
        clearInterval(leaseRenewal);
      }
    },
  });
  response.headers.set("X-Albert-Runtime", "omni");
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Albert-Omni-Deadline-Ms", String(ALBERT_OMNI_ANALYSIS_TIMEOUT_MS));
  response.headers.set("X-Request-Id", correlationId);
  return response;
}
