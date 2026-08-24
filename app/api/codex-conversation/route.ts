import { createHash } from "node:crypto";
import { ulid } from "ulid";
import {
  ALBERT_CODEX_ANALYTICAL_RUNTIME,
  ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  ALBERT_CODEX_DEFAULT_EFFORT,
  ALBERT_CODEX_DEFAULT_FAST_MODE,
  ALBERT_CODEX_DEFAULT_MODEL,
  ALBERT_CODEX_LOCAL_SIGNING_SECRET,
  ALBERT_CODEX_PINNED_CLI_VERSION,
  ALBERT_CODEX_PROTOCOL_VERSION,
  ALBERT_CODEX_RUNTIME,
  ALBERT_CODEX_MODEL_IDS,
  CodexRuntimeServiceClient,
  CodexRuntimeServiceError,
  codexSocialProvenance,
  codexSocialReply,
  codexConversationRequestSchema,
  codexPriorResultSchema,
  codexRuntimeServiceUrl,
  createCodexTraceTransportState,
  detectCodexSocialMessage,
  matchSemanticRules,
  projectCodexRuntimeEvent,
  type CodexPriorResult,
  type CodexTraceEventInput,
  type CodexServiceTurn,
} from "@/packages/albert-codex/src";
import { signCubeJwt } from "@/packages/albert-v3/src/cube/jwt";
import { normalizeAgentPreferences } from "@/packages/shared/src";
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
  buildSharedAnalyticalBrief,
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
import { createSupabaseAnalyticalQueryRecorder } from "@/services/control-plane/src/query-log-repository";
import { loadLatestSalesBriefing } from "@/services/control-plane/src/swarm-repository";
import { readSalesBriefingFile } from "@/services/swarm/src/sales-deep-store";
import { salesBriefingContextBlock } from "@/services/swarm/src/sales-deep";
import {
  loadSemanticMemory,
  recordSemanticRuleUse,
  saveSemanticRule,
} from "@/services/control-plane/src/semantic-memory-repository";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  loadConnectorRouting,
  loadSourceFindings,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

export const maxDuration = 800;

const LEASE_RENEWAL_INTERVAL_MS = 120_000;
const CODEX_PRIOR_RESULTS_MAX_BYTES = 48_000;
const logger = createServiceLogger("albert-codex-web");

function localErrorDetail(error: unknown): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  if (!message) return undefined;
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[redacted]")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted-token]")
    .replace(/\s+/gu, " ")
    .slice(0, 500);
}

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-request-id": correlationId,
    },
  });
}

function boundedJson(value: unknown, maxLength: number): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return undefined;
  }
}

function toCodexPriorResult(
  result: Awaited<ReturnType<typeof loadPriorTurnResults>>[number],
): CodexPriorResult | null {
  const provenance = result.provenance;
  const connector = result.connector ?? provenance?.sources[0]?.connector;
  if (!connector) return null;
  const columns = result.columns.slice(0, 12);
  const rows = result.rows.slice(0, 12).map((row) => Object.fromEntries(
    columns.map((column) => {
      const value = row[column.key] ?? null;
      return [column.key, typeof value === "string" ? value.slice(0, 160) : value];
    }),
  ));
  const candidate = {
    resultId: result.resultId,
    turnsAgo: result.turnsAgo,
    caption: result.caption,
    presentation: result.presentation,
    columns,
    rows,
    rowCount: result.rowCount,
    ...(result.view ? { view: result.view } : {}),
    connector,
    sources: (provenance?.sources ?? []).slice(0, 4),
    timeRange: provenance?.timeRange ?? {
      label: result.timeRangeLabel ?? "As previously retrieved",
      start: "unknown",
      end: "unknown",
      timezone: "UTC",
    },
    definitions: (provenance?.definitions ?? []).slice(0, 12),
    semanticBundleHash: provenance?.semanticBundleHash ?? "albert-codex-prior-result",
    identityGraph: provenance?.identityGraph ?? {
      version: 0,
      hash: "d41d8cd98f00b204e9800998ecf8427e",
    },
  };
  const parsed = codexPriorResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function boundedCodexPriorResults(
  results: Awaited<ReturnType<typeof loadPriorTurnResults>>,
): readonly CodexPriorResult[] {
  const selected: CodexPriorResult[] = [];
  let bytes = 0;
  for (const result of results) {
    const mapped = toCodexPriorResult(result);
    if (!mapped) continue;
    const nextBytes = Buffer.byteLength(JSON.stringify(mapped), "utf8");
    if (bytes + nextBytes > CODEX_PRIOR_RESULTS_MAX_BYTES) break;
    selected.push(mapped);
    bytes += nextBytes;
    if (selected.length >= 4) break;
  }
  return Object.freeze(selected);
}

function publicCodexFailure(error: unknown): string {
  if (error instanceof CodexRuntimeServiceError) {
    const byCode: Readonly<Record<string, string>> = {
      codex_forbidden_capability: "The Codex isolation check rejected an external capability. No business data was sent.",
      codex_runtime_unavailable: "The pinned Codex runtime is unavailable on this environment.",
      codex_semantic_unavailable: "The governed semantic layer was unavailable to Codex.",
      codex_overloaded: "Albert is unusually busy right now. Try again in a minute.",
      codex_cancelled: "The Codex analysis was cancelled before it finished.",
      codex_abandoned: "This analysis was superseded before it finished. Ask the question again.",
      codex_invalid_output: "Codex rejected the analytical output contract before answering.",
      codex_pro_unavailable: "Codex Pro reasoning is unavailable on this runtime authentication mode.",
      codex_turn_timeout: "The Codex analysis ran out of time before finishing.",
      replayed_request: "This Codex request was already used. Ask the question again.",
    };
    const mapped = byCode[error.code];
    if (mapped) return mapped;
  }
  const detail = error instanceof Error ? error.message : "";
  if (/external instruction source|external workspace root|external MCP|forbidden .* capability/iu.test(detail)) {
    return "The Codex isolation check rejected an external capability. No business data was sent.";
  }
  if (/Codex runtime version is|pinned Codex runtime is unavailable|install @openai\/codex|ENOENT/iu.test(detail)) {
    return "The pinned Codex runtime is unavailable on this environment.";
  }
  if (/structured output|output schema|malformed structured/iu.test(detail)) {
    return "Codex rejected the analytical output contract before answering.";
  }
  if (/401|api key|authentication|OpenAI|model/iu.test(detail)) {
    return "The Codex model request was rejected by OpenAI.";
  }
  if (/Cube|semantic|catalogue/iu.test(detail)) {
    return "The governed semantic layer was unavailable to Codex.";
  }
  return "The Codex analysis could not be completed safely.";
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
    parsed = codexConversationRequestSchema.parse(await readBoundedJsonBody(request));
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 400;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "A valid message is required.",
      status,
      correlationId,
    );
  }

  const preferences = normalizeAgentPreferences(parsed.preferences ?? {
    model: ALBERT_CODEX_DEFAULT_MODEL,
    reasoningEffort: ALBERT_CODEX_DEFAULT_EFFORT,
    fastMode: ALBERT_CODEX_DEFAULT_FAST_MODE,
  });
  const solPlanner = parsed.solPlanner === true;
  const reasoningMode = parsed.proMode === true ? "pro" : "standard";
  if (!(ALBERT_CODEX_MODEL_IDS as readonly string[]).includes(preferences.model)) {
    return jsonError("Codex supports GPT-5.6 Luna, Terra, and Sol only.", 400, correlationId);
  }
  const reasoningEffort = preferences.reasoningEffort === "none" ? "low" : preferences.reasoningEffort;

  const serviceUrl = codexRuntimeServiceUrl();
  const serviceSigningSecret = process.env.ALBERT_CODEX_RUNTIME_SIGNING_SECRET?.trim()
    || (process.env.NODE_ENV === "production" ? "" : ALBERT_CODEX_LOCAL_SIGNING_SECRET);
  const cubeApiSecret = process.env.CUBEJS_API_SECRET?.trim() ?? "";
  const cubeApiUrl = process.env.CUBE_API_URL?.trim() ?? "";
  if (
    !cubeApiSecret
    || !cubeApiUrl
    || !serviceUrl
    || !serviceSigningSecret
  ) {
    logger.error("codex.configuration_missing", {
      serviceUrl: Boolean(serviceUrl),
      serviceSigningSecret: Boolean(serviceSigningSecret),
      cubeApiSecret: Boolean(cubeApiSecret),
      cubeApiUrl: Boolean(cubeApiUrl),
    }, correlationId);
    return jsonError("The Codex experiment is not configured on this environment.", 503, correlationId);
  }

  const turnId = ulid();
  const runtimeProfile = {
    provider: "openai",
    runtime: ALBERT_CODEX_RUNTIME,
    analyticalRuntime: ALBERT_CODEX_ANALYTICAL_RUNTIME,
    model: preferences.model,
    reasoningEffort,
    reasoningMode,
    fastMode: preferences.fastMode,
    solPlanner,
    codexCliVersion: ALBERT_CODEX_PINNED_CLI_VERSION,
    codexProtocolVersion: ALBERT_CODEX_PROTOCOL_VERSION,
    analysisTimeoutMs: ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  } as const;

  let begun: Awaited<ReturnType<typeof beginConversationTurn>>;
  try {
    begun = await beginConversationTurn({
      conversationId: parsed.conversationId,
      turnId,
      message: parsed.message,
      runtimeProfile,
      replaceTurnId: parsed.replaceTurnId,
      staleLeaseFailureCode: "albert_codex_stale_lease_released",
      supabase: auth.supabase,
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("codex.turn_begin_failed", { status, ...safeErrorEvidence(error) }, correlationId);
    return jsonError("The Codex conversation could not be started.", status, correlationId);
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
          persist: (event) => appendConversationEvent({
            conversationId,
            turnId,
            event,
            supabase: auth.supabase,
          }),
          deliver: stream.emit,
          onPersistError: (error, event) => logger.warn("codex.local_conversation_trace_persist_failed", {
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
          logger.error("codex.local_conversation_turn_failed", safeErrorEvidence(error), correlationId);
          await failConversationTurn({
            conversationId,
            turnId,
            failureCode: "albert_codex_local_conversation_failure",
            supabase: auth.supabase,
          }).catch(() => undefined);
        }
      },
    });
    response.headers.set("X-Albert-Runtime", "codex");
    response.headers.set("X-Albert-Model", preferences.model);
    response.headers.set("X-Albert-Codex-Version", ALBERT_CODEX_PINNED_CLI_VERSION);
    response.headers.set("X-Request-Id", correlationId);
    return response;
  };

  const socialKind = detectCodexSocialMessage(parsed.message);
  if (socialKind) {
    const reply = codexSocialReply(socialKind, parsed.message);
    return localConversationResponse(
      reply.text,
      reply.followUps,
      "albert_codex_social_answered",
    );
  }

  const directConversationReply = directCodexConversationReply(
    parsed.message,
    tenant.timezone,
  );
  if (directConversationReply) {
    return localConversationResponse(
      directConversationReply,
      [],
      "albert_codex_direct_conversation_answered",
    );
  }

  const clearlyAnalytical = isClearlyAnalyticalCodexMessage(
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
          logger.warn("codex.message_router_failed", safeErrorEvidence(error), correlationId);
        }
        return { route: "analysis" as const, response: null };
      });
      if (decision.route === "conversation" && decision.response) {
        return localConversationResponse(
          decision.response,
          [],
          "albert_codex_routed_conversation_answered",
        );
      }
    }
  }
  // Every substantive analytical message gets its own contextual Nano
  // acknowledgement, including follow-ups in an existing conversation.
  // Social, trusted date/time, and routed general-chat replies return through
  // the earlier fast paths and deliberately do not pay for an analysis preamble.
  const acknowledgementApiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const initialAcknowledgementStartedAt = acknowledgementApiKey ? Date.now() : null;
  // Start the tiny prompt-specific request before context loading. The Codex
  // service turn starts independently later; its trace is buffered just long
  // enough to keep this acknowledgement in the first UI slot.
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
          logger.warn("codex.initial_acknowledgement_failed", {
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
  let connectorFreshness: readonly Readonly<{
    connector: string;
    domain: string;
    dataFrom?: string | null;
    dataThrough: string | null;
  }>[] = [];
  let businessContext: string | undefined;
  let sourceFindings: string | undefined;
  let priorResults: readonly CodexPriorResult[] = [];
  let semanticMemory: CodexServiceTurn["semanticMemory"];
  try {
    const [history, routing, context, findings, memoryRules, reusableResults, salesBriefing] = await Promise.all([
      loadConversationModelContext(conversationId, auth.supabase),
      loadConnectorRouting(auth.supabase).catch(() => undefined),
      loadBusinessContext(auth.supabase).catch(() => null),
      loadSourceFindings(auth.supabase).catch(() => undefined),
      loadSemanticMemory(auth.supabase).catch(() => [] as const),
      loadPriorTurnResults(conversationId, auth.supabase).catch((error) => {
        logger.warn("codex.prior_results_unavailable", {
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
        }, correlationId);
        return [] as const;
      }),
      loadLatestSalesBriefing().catch(() => null)
        .then((briefing) => briefing ?? readSalesBriefingFile()),
    ]);
    priorConversation = history.slice(-12).map(({ role, text }) => ({ role, text: text.slice(0, 8_000) }));
    activeConnectors = routing?.activeConnectors ?? [];
    connectorFreshness = routing?.freshness ?? [];
    const existingContext = context?.rendered.slice(0, 8_000) ?? "";
    const briefingBlock = typeof salesBriefing === "string" && salesBriefing.trim()
      ? salesBriefingContextBlock(salesBriefing)
      : "";
    businessContext = [existingContext, briefingBlock].filter(Boolean).join("\n\n").slice(0, 20_000) || undefined;
    sourceFindings = boundedJson(findings, 12_000);
    priorResults = boundedCodexPriorResults(reusableResults);
    // Learned vocabulary rules whose term appears in this question travel with
    // the turn so the runtime interprets the owner's words the taught way.
    const matchedRules = matchSemanticRules(parsed.message, memoryRules);
    if (matchedRules.length > 0) {
      semanticMemory = matchedRules
        .filter((rule) => rule.status !== "retired")
        .map((rule) => ({
          term: rule.term,
          meaning: rule.meaning,
          ...(rule.counterMeaning ? { counterMeaning: rule.counterMeaning } : {}),
          ...(rule.binding ? { binding: rule.binding } : {}),
          status: rule.status as "proposed" | "confirmed",
        }));
      void recordSemanticRuleUse(matchedRules.map((rule) => rule.ruleId), auth.supabase).catch(() => undefined);
    }
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

  // Every analytical turn carries at least the general brief so the owner's
  // goal and the depth-matching contract reach the runtime — and with them the
  // independent sufficiency review — instead of only the two regex-matched
  // question shapes.
  const analysisBrief = buildSharedAnalyticalBrief({
    message: parsed.message,
    activeConnectors,
    connectorFreshness,
    includeGeneric: true,
  });

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
  const client = new CodexRuntimeServiceClient(serviceUrl, serviceSigningSecret);

  logger.info("codex.turn_started", {
    tenantId: tenant.tenant_id,
    conversationId,
    turnId,
    model: preferences.model,
    reasoningMode,
    solPlanner,
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
        persist: (event) => appendConversationEvent({
          conversationId,
          turnId,
          event,
          supabase: auth.supabase,
        }),
        deliver: stream.emit,
        onPersistError: (error, event) => logger.warn("codex.trace_event_persist_failed", {
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
          logger.warn("codex.title_generation_failed", safeErrorEvidence(error), correlationId);
        }
      })();
      try {
        const serviceTurn: CodexServiceTurn = {
          protocolVersion: ALBERT_CODEX_PROTOCOL_VERSION,
          requestId: ulid(),
          tenantId: tenant.tenant_id,
          actorId: auth.user.id,
          role: tenant.role,
          conversationId,
          turnId,
          message: parsed.message,
          priorConversation: [...priorConversation],
          priorResults: [...priorResults],
          activeConnectors: [...activeConnectors],
          connectorFreshness: [...connectorFreshness],
          ...(businessContext ? { businessContext } : {}),
          ...(sourceFindings ? { sourceFindings } : {}),
          ...(semanticMemory?.length ? { semanticMemory } : {}),
          ...(analysisBrief ? { analysisBrief } : {}),
          cubeBearer,
          model: preferences.model,
          effort: reasoningEffort,
          fastMode: preferences.fastMode,
          // Optional protocol fields are omitted at their default so a web
          // rollout remains compatible with the immediately preceding strict
          // Fly runtime while the paired runtime deployment is converging.
          ...(solPlanner ? { solPlanner: true } : {}),
          ...(reasoningMode === "pro" ? { reasoningMode: "pro" as const } : {}),
        };
        const bufferedRuntimeEvents: CodexTraceEventInput[] = [];
        let traceTransportState = createCodexTraceTransportState();
        let runtimeTraceReleased = false;
        const deliverRuntimeEvent = async (event: CodexTraceEventInput) => {
          const projected = projectCodexRuntimeEvent(traceTransportState, event);
          for (const accepted of projected.events) {
            try {
              await emit(accepted);
            } catch (error) {
              // The trace contract stays authoritative, but one malformed
              // intermediate event must not discard a whole successful
              // analysis. Terminal answers are the only events worth failing
              // the turn over.
              logger.error("codex.trace_event_rejected", {
                conversationId,
                turnId,
                eventType: accepted.type,
                ...safeErrorEvidence(error),
                ...(localErrorDetail(error) ? { detail: localErrorDetail(error) } : {}),
              }, correlationId);
              if (accepted.type === "answer") throw error;
            }
          }
          traceTransportState = projected.state;
        };
        const emitRuntimeEvent = async (event: CodexTraceEventInput) => {
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
          logger.info("codex.initial_acknowledgement_completed", {
            tenantId: tenant.tenant_id,
            conversationId,
            turnId,
            model: LOW_LATENCY_ACKNOWLEDGEMENT_MODEL,
            reasoningEffort: LOW_LATENCY_ACKNOWLEDGEMENT_REASONING_EFFORT,
            requestedServiceTier: LOW_LATENCY_ACKNOWLEDGEMENT_SERVICE_TIER,
            actualServiceTier: acknowledgement.actualServiceTier,
            durationMs: initialAcknowledgementStartedAt === null
              ? null
              : Date.now() - initialAcknowledgementStartedAt,
            inputTokens: acknowledgement.usage?.inputTokens,
            outputTokens: acknowledgement.usage?.outputTokens,
            providerResponseId: acknowledgement.providerResponseId,
          }, correlationId);
        } else if (acknowledgementApiKey && !streamSignal.aborted) {
          logger.warn("codex.initial_acknowledgement_invalid", {
            conversationId,
            turnId,
            durationMs: initialAcknowledgementStartedAt === null
              ? null
              : Date.now() - initialAcknowledgementStartedAt,
          }, correlationId);
        }

        // Drain every event received while nano generated the first sentence,
        // then let later events stream directly. The analysis itself was
        // already running; only public trace ordering was held briefly.
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
          failureCode: result.answerState === "Unavailable" ? "albert_codex_unavailable" : "albert_codex_answered",
          supabase: auth.supabase,
        });
        // Persist vocabulary the runtime captured this turn (remember_term).
        // An explicit owner request lands confirmed; a detected correction
        // lands proposed, pending the owner's review under Albert's memory.
        for (const proposal of result.memoryProposals ?? []) {
          try {
            const stored = await saveSemanticRule({
              kind: "term_binding",
              term: proposal.term,
              meaning: proposal.meaning,
              counterMeaning: proposal.counterMeaning ?? null,
              binding: proposal.binding ?? null,
              status: proposal.trigger === "owner_request" ? "confirmed" : "proposed",
              source: "albert",
              conversationId,
              turnId,
            }, auth.supabase);
            logger.info("codex.semantic_rule_saved", {
              tenantId: tenant.tenant_id,
              conversationId,
              turnId,
              ruleId: stored.ruleId,
              status: stored.status,
              trigger: proposal.trigger,
            }, correlationId);
          } catch (memoryError) {
            logger.warn("codex.semantic_rule_save_failed", {
              tenantId: tenant.tenant_id,
              conversationId,
              turnId,
              ...safeErrorEvidence(memoryError),
            }, correlationId);
          }
        }
        logger.info("codex.turn_completed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          answerState: result.answerState,
          queriesExecuted: result.queriesExecuted,
          durationMs: result.durationMs,
        }, correlationId);
      } catch (error) {
        const disconnected = streamSignal.aborted;
        logger.error(disconnected ? "codex.turn_disconnected" : "codex.turn_failed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          ...safeErrorEvidence(error),
          ...(localErrorDetail(error) ? { detail: localErrorDetail(error) } : {}),
        }, correlationId);
        try {
          if (!disconnected) {
            await emit({
              type: "error",
              status: "error",
              message: publicCodexFailure(error),
              recoverable: true,
            });
          }
          await emit.drain?.();
          await failConversationTurn({
            conversationId,
            turnId,
            failureCode: disconnected ? "client_disconnected" : "codex_runtime_failure",
            supabase: auth.supabase,
          });
        } catch (finalizeError) {
          logger.error("codex.turn_finalize_failed", safeErrorEvidence(finalizeError), correlationId);
        }
      } finally {
        clearInterval(leaseRenewal);
      }
    },
  });
  response.headers.set("X-Albert-Runtime", "codex");
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Albert-Codex-Version", ALBERT_CODEX_PINNED_CLI_VERSION);
  response.headers.set("X-Albert-Codex-Deadline-Ms", String(ALBERT_CODEX_ANALYSIS_TIMEOUT_MS));
  if (analysisBrief) response.headers.set("X-Albert-Analysis-Brief", analysisBrief.digest);
  response.headers.set("X-Request-Id", correlationId);
  return response;
}
