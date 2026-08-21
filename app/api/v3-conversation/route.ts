import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import { describeChatFailure, isAnthropicModel, isXaiModel, normalizeAgentPreferences, providerForModel } from "@/packages/shared/src";
import { meterOpenAIUsage, toModelUsageRpcPayload } from "@/packages/usage-metering/src";
import { webBackendLoopbackMessage } from "@/packages/config/src/env";
import { xeroMcpServiceUrl } from "@/packages/xero-mcp/src/client";
import {
  ALBERT_V3_RUNTIME,
  SPECIALIST_AGENT_IDS,
  businessContextRefreshDue,
  detectSocialMessage,
  getSpecialistAgentDefinition,
  runAlbertV3Turn,
  specialistAgentAllowedForRole,
  specialistAgentDefinitionDigest,
  type ConversationMessage,
} from "@/packages/albert-v3/src";
import { loadBusinessContext, saveBusinessContext } from "@/services/control-plane/src/business-context-repository";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";
import {
  createLiveTraceSseResponse,
  createTraceEmitter,
  buildSharedAnalyticalBrief,
  generateConversationTitle,
  generateInitialAcknowledgement,
  INITIAL_ACKNOWLEDGEMENT_MODEL,
  INITIAL_ACKNOWLEDGEMENT_REASONING_EFFORT,
  INITIAL_ACKNOWLEDGEMENT_SERVICE_TIER,
} from "@/services/conversation/src";
import {
  appendConversationEvent,
  assignConversationTitle,
  beginConversationTurn,
  conversationNeedsTitle,
  loadConversationModelContext,
  loadPriorTurnResults,
  renewConversationTurnLease,
  failConversationTurn,
} from "@/services/conversation/src/artifact-store";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  loadConnectorRouting,
  loadSourceFindings,
  recordSourceFinding,
  type ConnectorRouting,
  type TenantSourceFindings,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

/** Deep-lane turns are long-running by design (Fluid compute ceiling). */
export const maxDuration = 800;

const LEASE_RENEWAL_INTERVAL_MS = 120_000;

const requestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
  specialistAgentId: z.enum(SPECIALIST_AGENT_IDS).optional(),
  comparisonMode: z.boolean().optional(),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  replaceTurnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  confirmedOption: z.object({
    offeredTurnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    optionId: z.string().min(1).max(80),
  }).strict().optional(),
});

const logger = createServiceLogger("albert-v3-web");

function jsonError(message: string, status: number, correlationId: string) {
  return Response.json(
    { error: message },
    { status, headers: { "x-request-id": correlationId, "Cache-Control": "no-store" } },
  );
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

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await readBoundedJsonBody(request));
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 400;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "A valid message is required.",
      status,
      correlationId,
    );
  }

  const preferences = normalizeAgentPreferences(parsed.preferences);
  const specialistAgentId = parsed.specialistAgentId ?? "general";
  const specialistAgent = getSpecialistAgentDefinition(specialistAgentId);
  if (!specialistAgentAllowedForRole(specialistAgentId, tenant.role)) {
    return jsonError(
      "The Customer Agent is available to organisation owners and managers.",
      403,
      correlationId,
    );
  }
  const loopbackBackends = webBackendLoopbackMessage();
  if (loopbackBackends) {
    logger.error("v3.loopback_backends", { message: loopbackBackends }, correlationId);
    return jsonError(loopbackBackends, 503, correlationId);
  }
  const grokSelected = isXaiModel(preferences.model);
  const haikuSelected = isAnthropicModel(preferences.model);
  if (
    haikuSelected
    && process.env.NODE_ENV === "production"
    && (
      process.env.ALBERT_ANTHROPIC_APP8_APPROVED !== "true"
      || process.env.ALBERT_ANTHROPIC_ZDR_APPROVED !== "true"
    )
  ) {
    return jsonError(
      "Claude Haiku is not approved for production data on this Albert environment.",
      503,
      correlationId,
    );
  }
  const configuration = {
    cubeApiUrl: process.env.CUBE_API_URL,
    cubeApiSecret: process.env.CUBEJS_API_SECRET,
    shopifyQLServiceUrl: process.env.SYNC_WORKER_INTERNAL_URL,
    shopifyQLSigningSecret: process.env.ALBERT_SHOPIFYQL_SIGNING_SECRET,
    shopifyAdminServiceUrl: process.env.SYNC_WORKER_INTERNAL_URL,
    shopifyAdminSigningSecret: process.env.ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET,
    openaiApiKey: process.env.OPENAI_API_KEY,
    ...(grokSelected ? { xaiApiKey: process.env.XAI_API_KEY } : {}),
    ...(haikuSelected ? { anthropicApiKey: process.env.ANTHROPIC_API_KEY } : {}),
  };
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.error("v3.configuration_missing", { missing }, correlationId);
    if (grokSelected && missing.includes("xaiApiKey")) {
      return jsonError("Grok is not configured (XAI_API_KEY is missing).", 503, correlationId);
    }
    if (haikuSelected && missing.includes("anthropicApiKey")) {
      return jsonError("Claude Haiku is not configured (ANTHROPIC_API_KEY is missing).", 503, correlationId);
    }
    return jsonError(
      describeChatFailure(undefined, { missingConfig: missing, phase: "config" }),
      503,
      correlationId,
    );
  }

  const turnId = ulid();
  const runtimeProfile = {
    provider: providerForModel(preferences.model),
    runtime: ALBERT_V3_RUNTIME,
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort,
    fastMode: preferences.fastMode,
    analyticalRuntime: "cube-v3",
    specialistAgentId,
    specialistAgentVersion: specialistAgent.version,
    specialistAgentDigest: specialistAgentDefinitionDigest(specialistAgent),
  } as const;

  let begun;
  try {
    begun = await beginConversationTurn({
      conversationId: parsed.conversationId,
      turnId,
      message: parsed.message,
      runtimeProfile,
      confirmedOption: parsed.confirmedOption,
      replaceTurnId: parsed.replaceTurnId,
      staleLeaseFailureCode: "albert_v3_stale_lease_released",
      supabase: auth.supabase,
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("v3.turn_begin_failed", { status, ...safeErrorEvidence(error) }, correlationId);
    return jsonError(
      describeChatFailure(
        error instanceof Error ? error.message : "The Albert v3 conversation could not be started.",
        { runtime: "v3", phase: "start" },
      ),
      status,
      correlationId,
    );
  }
  const conversationId = begun.conversationId;
  const shouldGenerateInitialAcknowledgement = detectSocialMessage(parsed.message) === null
    // Specialist chats already carry an immediate, request-specific profile
    // acknowledgement in the UI and start with a focused cached prefix. A
    // second auxiliary model call would add up to four seconds before the
    // analytical engine can begin, defeating the specialist latency contract.
    && specialistAgentId === "general";
  const initialAcknowledgementStartedAt = shouldGenerateInitialAcknowledgement ? Date.now() : null;
  // Start the small Luna request before the independent context reads. By the
  // time SSE is mounted it is normally already complete, while any failure is
  // isolated from the analytical turn.
  const initialAcknowledgement = shouldGenerateInitialAcknowledgement
    ? generateInitialAcknowledgement({
        question: parsed.message,
        apiKey: configuration.openaiApiKey!,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        safetyIdentifier: createHash("sha256")
          .update(`${tenant.tenant_id}:${auth.user.id}`)
          .digest("hex"),
        signal: request.signal,
      }).catch((error) => {
        if (!request.signal.aborted) {
          logger.warn("v3.initial_acknowledgement_failed", {
            conversationId,
            turnId,
            ...safeErrorEvidence(error),
          }, correlationId);
        }
        return null;
      })
    : Promise.resolve(null);

  let conversation: readonly ConversationMessage[];
  let activeConnectors: readonly string[] | undefined;
  let connectorFreshness: ConnectorRouting["freshness"] | undefined;
  let sourceFindings: TenantSourceFindings | undefined;
  let priorResults: Awaited<ReturnType<typeof loadPriorTurnResults>> = [];
  let businessContext: Awaited<ReturnType<typeof loadBusinessContext>> = null;
  try {
    const [priorMessages, routing, findings, priorTurnResults, storedContext] = await Promise.all([
      loadConversationModelContext(conversationId, auth.supabase),
      loadConnectorRouting(auth.supabase).catch((error) => {
        // Routing metadata is a cost optimisation, not an authorisation
        // boundary. Fail open so a transient control-plane read cannot hide a
        // valid query tool or degrade answer quality.
        logger.warn("v3.connector_routing_unavailable", {
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        return undefined;
      }),
      loadSourceFindings(auth.supabase).catch((error) => {
        // Same fail-open stance as routing: findings improve answers but a
        // transient read failure must never block a turn.
        logger.warn("v3.source_findings_unavailable", {
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        return undefined;
      }),
      // Earlier turns' result sets let follow-ups re-present already-retrieved
      // data without re-running the pipeline; a read failure only costs speed.
      loadPriorTurnResults(conversationId, auth.supabase).catch((error) => {
        logger.warn("v3.prior_results_unavailable", {
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        return [] as const;
      }),
      // The business context document grounds every turn; a read failure only
      // costs grounding, never the turn.
      loadBusinessContext(auth.supabase).catch((error) => {
        logger.warn("v3.business_context_unavailable", {
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        return null;
      }),
    ]);
    activeConnectors = routing?.activeConnectors;
    connectorFreshness = routing?.freshness;
    sourceFindings = findings;
    priorResults = priorTurnResults;
    businessContext = storedContext;
    conversation = [
      ...priorMessages.map(({ role, text, governedQueries, resolvedSubject, presentedTables }) => ({
        role,
        text,
        ...(governedQueries?.length ? { governedQueries } : {}),
        ...(resolvedSubject ? { resolvedSubject } : {}),
        ...(presentedTables?.length ? { presentedTables } : {}),
      })),
      { role: "user" as const, text: parsed.message },
    ];
  } catch (error) {
    await failConversationTurn({
      conversationId,
      turnId,
      failureCode: "context_unavailable",
      supabase: auth.supabase,
    }).catch(() => undefined);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof Error ? error.message : "The conversation context is unavailable.",
      status,
      correlationId,
    );
  }

  const analysisBrief = parsed.comparisonMode
    ? buildSharedAnalyticalBrief({
        message: parsed.message,
        activeConnectors,
        connectorFreshness,
        includeGeneric: true,
      })
    : undefined;

  logger.info("v3.turn_started", {
    tenantId: tenant.tenant_id,
    conversationId,
    turnId,
    model: preferences.model,
    specialistAgentId,
  }, correlationId);

  const response = createLiveTraceSseResponse({
    conversationId,
    turnId,
    signal: request.signal,
    run: async (stream, streamSignal) => {
      const leaseRenewal = setInterval(() => {
        void renewConversationTurnLease({ supabase: auth.supabase, turnId }).catch(() => undefined);
      }, LEASE_RENEWAL_INTERVAL_MS);

      // Title generation stays off the analytical critical path.
      void (async () => {
        try {
          if (!await conversationNeedsTitle(conversationId, auth.supabase)) return;
          const title = await generateConversationTitle({
            question: parsed.message,
            apiKey: configuration.openaiApiKey!,
            baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
            signal: streamSignal,
          });
          if (!title || streamSignal.aborted) return;
          const assignment = await assignConversationTitle({
            conversationId,
            title,
            supabase: auth.supabase,
          });
          if (assignment.assigned) stream.emitConversationTitle(assignment.title);
        } catch (error) {
          logger.warn("v3.title_generation_failed", safeErrorEvidence(error), correlationId);
        }
      })();

      const emit = createTraceEmitter({
        persist: (event) => appendConversationEvent({
          conversationId,
          turnId,
          event,
          supabase: auth.supabase,
        }),
        onPersistError: (error, event) => {
          logger.warn("v3.trace_event_persist_failed", {
            conversationId,
            turnId,
            eventType: event.type,
            eventSequence: event.sequence,
            ...safeErrorEvidence(error),
          }, correlationId);
        },
        deliver: stream.emit,
      });

      try {
        const acknowledgement = await initialAcknowledgement;
        if (acknowledgement && !streamSignal.aborted) {
          await emit({
            type: "narrative",
            purpose: "acknowledgement",
            text: acknowledgement.text,
          });
          logger.info("v3.initial_acknowledgement_completed", {
            tenantId: tenant.tenant_id,
            conversationId,
            turnId,
            model: INITIAL_ACKNOWLEDGEMENT_MODEL,
            reasoningEffort: INITIAL_ACKNOWLEDGEMENT_REASONING_EFFORT,
            requestedServiceTier: INITIAL_ACKNOWLEDGEMENT_SERVICE_TIER,
            actualServiceTier: acknowledgement.actualServiceTier,
            durationMs: initialAcknowledgementStartedAt === null
              ? null
              : Date.now() - initialAcknowledgementStartedAt,
            inputTokens: acknowledgement.usage?.inputTokens,
            outputTokens: acknowledgement.usage?.outputTokens,
            providerResponseId: acknowledgement.providerResponseId,
          }, correlationId);
        } else if (shouldGenerateInitialAcknowledgement && !streamSignal.aborted) {
          logger.warn("v3.initial_acknowledgement_invalid", {
            conversationId,
            turnId,
            durationMs: initialAcknowledgementStartedAt === null
              ? null
              : Date.now() - initialAcknowledgementStartedAt,
          }, correlationId);
        }

        const result = await runAlbertV3Turn({
          message: parsed.message,
          conversation,
          preferences,
          tenantId: tenant.tenant_id,
          actorId: auth.user.id,
          role: tenant.role,
          specialistAgentId,
          activeConnectors,
          connectorFreshness,
          sourceFindings,
          priorResults,
          analysisBrief,
          businessContext: {
            ...(businessContext ? { current: businessContext, ownerLocked: businessContext.ownerLocked } : {}),
            // Only owners/managers may write it; a stale or missing document is
            // regenerated under this turn's lease and saved before it ends.
            refresh: {
              due: (tenant.role === "owner" || tenant.role === "manager") && (activeConnectors?.length ?? 0) > 0 && businessContextRefreshDue({
                generatedAt: businessContext?.generatedAt ?? null,
                connectors: businessContext?.connectors ?? [],
                activeConnectors: activeConnectors ?? [],
              }),
              save: async (generated) => {
                await saveBusinessContext({
                  document: generated.document,
                  rendered: generated.rendered,
                  source: "generated",
                  facts: generated.facts,
                  generatorVersion: generated.generatorVersion,
                  model: generated.model,
                  dataThrough: generated.dataThrough,
                  connectors: generated.connectors,
                }, auth.supabase);
                logger.info("v3.business_context_refreshed", {
                  tenantId: tenant.tenant_id, conversationId, turnId, words: generated.words, durationMs: generated.durationMs,
                }, correlationId);
              },
            },
          },
          recordSourceFinding: async (concept, finding) => {
            await recordSourceFinding(concept, finding, auth.supabase);
          },
          conversationId,
          turnId,
          cubeApiUrl: configuration.cubeApiUrl!,
          cubeApiSecret: configuration.cubeApiSecret!,
          shopifyQLServiceUrl: configuration.shopifyQLServiceUrl!,
          shopifyQLSigningSecret: configuration.shopifyQLSigningSecret!,
          shopifyAdminServiceUrl: configuration.shopifyAdminServiceUrl!,
          shopifyAdminSigningSecret: configuration.shopifyAdminSigningSecret!,
          // Live Xero statements (P&L, balance sheet, trial balance, aged
          // reports) via the worker's xero-mcp boundary, signed with the OAuth
          // worker secret it already verifies. Resolved the same way in every
          // environment (override → sync worker → local sidecar) so localhost
          // and Vercel behave alike. Optional: the engine omits the tools when
          // the secret is absent.
          xeroMcpServiceUrl: xeroMcpServiceUrl() || undefined,
          xeroMcpSigningSecret: process.env.ALBERT_OAUTH_WORKER_SIGNING_SECRET || undefined,
          openaiApiKey: configuration.openaiApiKey!,
          openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
          xaiApiKey: process.env.XAI_API_KEY || undefined,
          xaiBaseUrl: process.env.XAI_BASE_URL || undefined,
          anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
          anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
          openaiTracingEnabled: process.env.ALBERT_OPENAI_TRACING_ENABLED === "true",
          signal: streamSignal,
          emit,
          onProviderUsage: async (providerUsage, providerResponseId) => {
            try {
              const metering = meterOpenAIUsage({
                model: preferences.model,
                fastMode: preferences.fastMode,
                usage: providerUsage,
              });
              const { error } = await auth.supabase.rpc("albert_record_turn_usage", {
                p_conversation_id: conversationId,
                p_turn_id: turnId,
                p_metering: toModelUsageRpcPayload(metering),
              });
              if (error) throw new Error(error.message);
              logger.info("v3.usage_recorded", {
                tenantId: tenant.tenant_id,
                conversationId,
                turnId,
                model: preferences.model,
                inputTokens: metering.inputTokens,
                cachedInputTokens: metering.cachedInputTokens,
                cacheWriteInputTokens: metering.cacheWriteInputTokens,
                outputTokens: metering.outputTokens,
                estimatedCostUsdMicros: metering.estimatedCostUsdMicros,
                providerResponseId,
              }, correlationId);
            } catch (error) {
              logger.warn("v3.usage_record_failed", {
                conversationId,
                turnId,
                ...safeErrorEvidence(error),
              }, correlationId);
            }
          },
        });
        await emit.drain?.();
        // Authenticated web clients cannot call complete_albert_turn (revoked
        // in M8 artefact lineage); release the lease the same way Cubecore
        // does so follow-up turns can begin.
        await failConversationTurn({
          conversationId,
          turnId,
          failureCode: result.answerState === "Unavailable"
            ? "albert_v3_unavailable"
            : "albert_v3_answered",
          supabase: auth.supabase,
        });
        logger.info("v3.turn_completed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          answerState: result.answerState,
          queriesExecuted: result.queriesExecuted,
        }, correlationId);
      } catch (error) {
        const disconnected = streamSignal.aborted;
        logger.error(disconnected ? "v3.turn_disconnected" : "v3.turn_failed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "unknown",
        }, correlationId);
        try {
          if (!disconnected) {
            await emit({
              type: "error",
              status: "error",
              message: describeChatFailure(error, { runtime: "v3" }),
              recoverable: true,
            });
          }
          await emit.drain?.();
          await failConversationTurn({
            conversationId,
            turnId,
            failureCode: disconnected ? "client_disconnected" : "runtime_failure",
            supabase: auth.supabase,
          });
        } catch (finalizeError) {
          logger.error("v3.turn_finalize_failed", safeErrorEvidence(finalizeError), correlationId);
        }
      } finally {
        clearInterval(leaseRenewal);
      }
    },
  });
  response.headers.set("X-Albert-Runtime", "v3");
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Albert-Specialist-Agent", specialistAgentId);
  if (analysisBrief) response.headers.set("X-Albert-Analysis-Brief", analysisBrief.digest);
  response.headers.set("X-Request-Id", correlationId);
  return response;
}
