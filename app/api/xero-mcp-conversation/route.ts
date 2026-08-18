import { ulid } from "ulid";
import { z } from "zod";
import { describeChatFailure, isXaiModel, normalizeAgentPreferences, providerForModel } from "@/packages/shared/src";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
} from "@/packages/observability/src";
import {
  createLiveTraceSseResponse,
  createTraceEmitter,
  generateConversationTitle,
} from "@/services/conversation/src";
import {
  appendConversationEvent,
  assignConversationTitle,
  beginConversationTurn,
  conversationNeedsTitle,
  loadConversationModelContext,
  renewConversationTurnLease,
  failConversationTurn,
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
import { runXeroMcpTurn } from "@/packages/xero-mcp/src/agent";
import { XeroMcpClient, xeroMcpServiceUrl } from "@/packages/xero-mcp/src/client";
import { XERO_MCP_RUNTIME, XERO_MCP_RUNTIME_HEADER } from "@/packages/xero-mcp/src/types";

export const maxDuration = 800;

const LEASE_RENEWAL_INTERVAL_MS = 120_000;

const requestSchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  preferences: z.unknown().optional(),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  replaceTurnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  confirmedOption: z.object({
    offeredTurnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    optionId: z.string().min(1).max(80),
  }).strict().optional(),
});

const logger = createServiceLogger("albert-xero-mcp-web");

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
  const grokSelected = isXaiModel(preferences.model);
  const serviceUrl = xeroMcpServiceUrl();
  const signingSecret = process.env.ALBERT_OAUTH_WORKER_SIGNING_SECRET;
  const configuration = {
    openaiApiKey: process.env.OPENAI_API_KEY,
    xeroMcpServiceUrl: serviceUrl,
    xeroMcpSigningSecret: signingSecret,
    ...(grokSelected ? { xaiApiKey: process.env.XAI_API_KEY } : {}),
  };
  const missing = Object.entries(configuration)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    logger.error("xero_mcp.configuration_missing", { missing }, correlationId);
    return jsonError(
      describeChatFailure(undefined, { missingConfig: missing, phase: "config" }),
      503,
      correlationId,
    );
  }

  const turnId = ulid();
  const runtimeProfile = {
    provider: providerForModel(preferences.model),
    runtime: XERO_MCP_RUNTIME,
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort,
    fastMode: preferences.fastMode,
    analyticalRuntime: XERO_MCP_RUNTIME,
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
      staleLeaseFailureCode: "albert_xero_mcp_stale_lease_released",
      supabase: auth.supabase,
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    logger.error("xero_mcp.turn_begin_failed", { status, ...safeErrorEvidence(error) }, correlationId);
    return jsonError(
      describeChatFailure(
        error instanceof Error ? error.message : "The Xero MCP conversation could not be started.",
        { runtime: "xero_mcp", phase: "start" },
      ),
      status,
      correlationId,
    );
  }
  const conversationId = begun.conversationId;

  let conversation: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  try {
    const priorMessages = await loadConversationModelContext(conversationId, auth.supabase);
    conversation = [
      ...priorMessages.map(({ role, text }) => ({ role, text })),
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

  logger.info("xero_mcp.turn_started", {
    tenantId: tenant.tenant_id,
    conversationId,
    turnId,
    model: preferences.model,
  }, correlationId);

  const response = createLiveTraceSseResponse({
    conversationId,
    turnId,
    signal: request.signal,
    run: async (stream, streamSignal) => {
      const leaseRenewal = setInterval(() => {
        void renewConversationTurnLease({ supabase: auth.supabase, turnId }).catch(() => undefined);
      }, LEASE_RENEWAL_INTERVAL_MS);

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
            title: title.startsWith("Xero") ? title : `Xero: ${title}`,
            supabase: auth.supabase,
          });
          if (assignment.assigned) stream.emitConversationTitle(assignment.title);
        } catch (error) {
          logger.warn("xero_mcp.title_generation_failed", safeErrorEvidence(error), correlationId);
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
          logger.warn("xero_mcp.trace_event_persist_failed", {
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
        const client = new XeroMcpClient(serviceUrl, signingSecret!, {
          tenantId: tenant.tenant_id,
          actorId: auth.user.id,
          role: tenant.role,
          conversationId,
          turnId,
        });
        const result = await runXeroMcpTurn({
          message: parsed.message,
          conversation,
          preferences,
          client,
          openaiApiKey: configuration.openaiApiKey!,
          openaiBaseUrl: process.env.OPENAI_BASE_URL || undefined,
          xaiApiKey: process.env.XAI_API_KEY || undefined,
          xaiBaseUrl: process.env.XAI_BASE_URL || undefined,
          signal: streamSignal,
          emit,
        });
        await emit.drain?.();
        await failConversationTurn({
          conversationId,
          turnId,
          failureCode: result.answerState === "Unavailable"
            ? "albert_xero_mcp_unavailable"
            : "albert_xero_mcp_answered",
          supabase: auth.supabase,
        });
        logger.info("xero_mcp.turn_completed", {
          tenantId: tenant.tenant_id,
          conversationId,
          turnId,
          answerState: result.answerState,
          toolsUsed: result.toolsUsed,
        }, correlationId);
      } catch (error) {
        const disconnected = streamSignal.aborted;
        logger.error(disconnected ? "xero_mcp.turn_disconnected" : "xero_mcp.turn_failed", {
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
              message: describeChatFailure(error, { runtime: "xero_mcp" }),
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
          logger.error("xero_mcp.turn_finalize_failed", safeErrorEvidence(finalizeError), correlationId);
        }
      } finally {
        clearInterval(leaseRenewal);
      }
    },
  });
  response.headers.set("X-Albert-Runtime", XERO_MCP_RUNTIME_HEADER);
  response.headers.set("X-Albert-Model", preferences.model);
  response.headers.set("X-Request-Id", correlationId);
  return response;
}
