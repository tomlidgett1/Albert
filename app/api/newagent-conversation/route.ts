import { ulid } from "ulid";
import { z } from "zod";
import { AgentsApiError } from "@/packages/albert-agents-api/src/harness";
import { NativeManagedHarness } from "@/packages/albert-agents-api/src/native-harness";
import { AGENTS_API_MODEL_IDS, AGENTS_API_RUNTIME, DEFAULT_AGENTS_API_PREFERENCES } from "@/packages/albert-agents-api/src/config";
import { runGovernedAnalyticalTurn } from "@/packages/albert-omni/src/runtime";
import { omniConversationRequestSchema, type OmniServiceTurn } from "@/packages/albert-omni/src/contracts";
import { omniPriorResults } from "@/packages/albert-omni/src/context";
import { pairDerivedTableEvent } from "@/packages/albert-omni/src/pivot";
import { signCubeJwt } from "@/packages/albert-v3/src/cube/jwt";
import { createServiceLogger, safeErrorEvidence, correlationIdFromHeader } from "@/packages/observability/src";
import { requireUser, currentTenantContext, consumeAlbertRateLimit, loadConnectorRouting, ControlPlaneError } from "@/services/control-plane/src/web-repository";
import { assertSameOriginMutation, readBoundedJsonBody, rateLimitExceededResponse } from "@/services/control-plane/src/request-security";
import { loadBusinessContext } from "@/services/control-plane/src/business-context-repository";
import { createSupabaseAnalyticalQueryRecorder } from "@/services/control-plane/src/query-log-repository";
import { appendConversationEvent, beginConversationTurn, failConversationTurn, loadConversationModelContext, loadPriorTurnResults, renewConversationTurnLease, assignConversationTitle } from "@/services/conversation/src/artifact-store";
import { createLiveTraceSseResponse, createTraceEmitter } from "@/services/conversation/src";
import { claimManagedAgentState } from "@/services/conversation/src/managed-agent-store";

export const maxDuration = 800;

const logger = createServiceLogger("albert-agents-api-web");
const requestSchema = omniConversationRequestSchema.extend({
  preferences: z.object({
    model: z.enum(AGENTS_API_MODEL_IDS),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh", "max"]),
    fastMode: z.boolean(),
  }).strict().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  const jsonError = (error: string, status: number) => Response.json({ error }, {
    status, headers: { "cache-control": "no-store", "x-request-id": correlationId },
  });
  let auth: Awaited<ReturnType<typeof requireUser>>;
  let tenant: NonNullable<Awaited<ReturnType<typeof currentTenantContext>>>;
  let parsed: z.infer<typeof requestSchema>;
  try {
    assertSameOriginMutation(request);
    auth = await requireUser();
    const context = await currentTenantContext();
    if (!context) return jsonError("Create your organisation before starting a conversation.", 409);
    tenant = context;
    parsed = requestSchema.parse(await readBoundedJsonBody(request));
    const rateLimit = await consumeAlbertRateLimit("conversation.turn");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);
  } catch (error) {
    if (error instanceof ControlPlaneError) return jsonError(error.message, error.status);
    if (error instanceof z.ZodError) return jsonError("A valid message and supported OpenAI model are required.", 400);
    return jsonError("Authentication could not be completed.", 503);
  }
  if (process.env.ALBERT_AGENTS_API_DATA_CONTROL_APPROVED !== "true") {
    return jsonError("The new Agents API is awaiting approval for US session storage. Your message has not been sent to OpenAI.", 503);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const cubeApiUrl = process.env.CUBE_API_URL?.trim();
  const cubeApiSecret = process.env.CUBEJS_API_SECRET?.trim();
  const serverKey = process.env.ALBERT_AGENTS_STATE_SECRET?.trim();
  if (!apiKey || !cubeApiUrl || !cubeApiSecret || !serverKey) return jsonError("The managed agent or governed data connection is not configured.", 503);
  const preferences = parsed.preferences ?? DEFAULT_AGENTS_API_PREFERENCES;
  const turnId = ulid();
  let conversationId: string;
  try {
    const begun = await beginConversationTurn({
      conversationId: parsed.conversationId,
      turnId,
      message: parsed.message,
      runtimeProfile: {
        provider: "openai", runtime: AGENTS_API_RUNTIME,
        analyticalRuntime: "cube-agents-api-v1", nativeVersion: 2, ...preferences,
      },
      replaceTurnId: parsed.replaceTurnId,
      supabase: auth.supabase,
    });
    conversationId = begun.conversationId;
  } catch (error) {
    return jsonError(error instanceof ControlPlaneError ? error.message : "The conversation could not be started.", error instanceof ControlPlaneError ? error.status : 503);
  }
  const cubeBearer = signCubeJwt({ secret: cubeApiSecret, expiresInSeconds: 900, securityContext: {
    tenant_id: tenant.tenant_id, role: tenant.role,
    specialist_agent_id: "general", specialist_agent_version: 1,
    conversation_id: conversationId, turn_id: turnId,
  } });
  const response = createLiveTraceSseResponse({
    conversationId, turnId, signal: request.signal,
    // Closing/stopping cancels managed work; an interrupted session rotates on retry.
    run: async (stream, signal) => {
      const renewal = setInterval(() => {
        void renewConversationTurnLease({ supabase: auth.supabase, turnId });
      }, 120_000);
      let harness: NativeManagedHarness | undefined;
      const emit = createTraceEmitter({
        persistenceAttempts: 4, requireDurableTerminal: true,
        persist: (event) => appendConversationEvent({ conversationId, turnId, event, supabase: auth.supabase }),
        deliver: stream.emit,
        onPersistError: (error) => logger.error("agents_api.trace_persist_failed", safeErrorEvidence(error), correlationId),
      });
      const queryEvents = new Map<string, string>();
      const tableEvents = new Map<string, string>();
      try {
        await emit({ type: "progress", status: "running", stage: "planning", label: "Starting the new agent" });
        const [history, routing, context, prior, sessionStore] = await Promise.all([
          loadConversationModelContext(conversationId, auth.supabase),
          // Require routing metadata before contextualizing a managed session.
          loadConnectorRouting(auth.supabase),
          loadBusinessContext(auth.supabase),
          loadPriorTurnResults(conversationId, auth.supabase),
          claimManagedAgentState({ supabase: auth.supabase, conversationId, turnId, serverKey }),
        ]);
        harness = new NativeManagedHarness({
          apiKey, scope: { tenantId: tenant.tenant_id, actorId: auth.user.id, conversationId, turnId },
          state: sessionStore.state, saveState: sessionStore.save,
        });
        if (!parsed.conversationId) {
          const title = parsed.message.replace(/\s+/gu, " ").slice(0, 100);
          const assigned = await assignConversationTitle({ conversationId, title, supabase: auth.supabase });
          if (assigned.assigned) stream.emitConversationTitle(assigned.title);
        }
        const turn: OmniServiceTurn = {
          protocolVersion: 1, requestId: ulid(),
          tenantId: tenant.tenant_id, actorId: auth.user.id, role: tenant.role,
          conversationId, turnId, message: parsed.message,
          priorConversation: history.slice(-12).map(({ role, text }) => ({ role, text: text.slice(0, 24_000) })),
          priorResults: omniPriorResults(prior),
          activeConnectors: [...routing.activeConnectors], connectorFreshness: [...routing.freshness],
          ...(context ? { businessContext: `Historical business profile (generated ${context.generatedAt ?? context.updatedAt}). Use it for business identity, terminology and preferences. Its dated connector-coverage notes describe that snapshot, not current data freshness.\n\n${context.rendered.slice(0, 19_500)}` } : {}),
          timezone: tenant.timezone, organisationName: tenant.tenant_name.slice(0, 160),
          cubeBearer, model: preferences.model, effort: preferences.reasoningEffort as OmniServiceTurn["effort"], fastMode: preferences.fastMode,
          ...(parsed.dashboardBuild ? { dashboardBuild: true } : {}),
          ...(parsed.dashboardEdit ? { dashboardEdit: true, dashboardEditTopic: parsed.dashboardEditTopic } : {}),
        };
        const outcome = await runGovernedAnalyticalTurn({
          turn, cubeApiUrl, openai: { apiKey, baseUrl: "https://api.openai.com/v1" },
          harness, signal,
          loadResults: sessionStore.loadResults,
          queryRecorder: createSupabaseAnalyticalQueryRecorder({ supabase: auth.supabase, conversationId, turnId, correlationId }),
          emit: async (event) => {
            if (event.type === "table" && event.dashboardReplay?.kind === "cube_v3") {
              const id = queryEvents.get(event.resultId);
              event = { ...event, dashboardReplay: id ? { ...event.dashboardReplay, queryEventId: id } : undefined };
            }
            if (event.type === "table" && event.dashboardReplay?.kind === "derived_v1") {
              const paired = pairDerivedTableEvent(event, tableEvents);
              event = paired ? { ...event, ...paired } : { ...event, dashboardReplay: undefined, dashboardDerivation: undefined };
            }
            const stamped = await emit(event);
            if (stamped.type === "query" && stamped.resultId) queryEvents.set(stamped.resultId, stamped.id);
            if (stamped.type === "table" && stamped.resultId) tableEvents.set(stamped.resultId, stamped.id);
          },
        });
        await emit.drain?.();
        await sessionStore.complete();
        logger.info("agents_api.turn_completed", { conversationId, turnId,
          answerState: outcome.answerState, queriesExecuted: outcome.queriesExecuted,
          durationMs: outcome.durationMs, native: harness.metrics,
        }, correlationId);
      } catch (error) {
        logger.error("agents_api.turn_failed", { conversationId, turnId, ...safeErrorEvidence(error) }, correlationId);
        if (!signal.aborted) await emit({ type: "error", status: "error", recoverable: true,
          message: error instanceof AgentsApiError ? error.message : "The new agent could not complete the analysis. Please try again.",
        });
        await emit.drain?.();
        await failConversationTurn({ conversationId, turnId, failureCode: signal.aborted ? "client_cancelled" : "agents_api_failed", supabase: auth.supabase });
      } finally {
        clearInterval(renewal);
        // Also covers failures before the governed runtime takes ownership.
        await harness?.close().catch((error) => logger.error("agents_api.cleanup_failed", { conversationId, turnId, ...safeErrorEvidence(error) }, correlationId));
      }
    },
  });
  response.headers.set("X-Albert-Runtime", "newagent");
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Request-Id", correlationId);
  return response;
}
