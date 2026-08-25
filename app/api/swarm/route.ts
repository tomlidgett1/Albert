/**
 * Codex Swarm (ADR 0120).
 *
 * GET  → latest run (or the run for ?conversationId=) plus child conversation
 *         ids the dash hides from sidebar history.
 * POST → plan the work, begin the parent Codex turn, persist the run, return
 *         the agents for the browser to fan out through /api/codex-conversation.
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import {
  ALBERT_CODEX_ANALYTICAL_RUNTIME,
  ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  ALBERT_CODEX_PINNED_CLI_VERSION,
  ALBERT_CODEX_PROTOCOL_VERSION,
  ALBERT_CODEX_RUNTIME,
} from "@/packages/albert-codex/src";
import { normalizeAgentPreferences } from "@/packages/shared/src";
import {
  appendConversationEvent,
  assignConversationTitle,
  beginConversationTurn,
  conversationNeedsTitle,
  failConversationTurn,
} from "@/services/conversation/src/artifact-store";
import { generateConversationTitle } from "@/services/conversation/src";
import { loadBusinessContext } from "@/services/control-plane/src/business-context-repository";
import {
  beginSwarmRun,
  loadSwarmForConversation,
  loadSwarmPanel,
} from "@/services/control-plane/src/swarm-repository";
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
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";
import {
  SWARM_CLIENT_CONCURRENCY,
  allocateSwarmPlan,
  prepareSwarmAgents,
} from "@/services/swarm/src/planner";
import {
  SALES_DEEP_KIND,
  SALES_DEEP_PREFERENCES,
  prepareSalesDeepAgents,
  salesDeepPlan,
} from "@/services/swarm/src/sales-deep";
import {
  SUPER_AGENT_CHECKPOINT_INTERVAL_MS,
  SUPER_AGENT_CONCURRENCY,
  SUPER_AGENT_DURATION_MS,
  SUPER_AGENT_KIND,
  SUPER_AGENT_PREFERENCES,
  SUPER_AGENT_PRO_MODE,
  SUPER_AGENT_SOL_PLANNER,
  prepareSuperAgentPasses,
  superAgentPlan,
} from "@/services/swarm/src/super-agent";
import { swarmPlanSteps } from "@/services/swarm/src/parent-events";

const logger = createServiceLogger("albert-swarm-web");

const bodySchema = z.object({
  message: z.string().trim().min(1).max(8_000),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  replaceTurnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(),
  preferences: z.unknown().optional(),
  solPlanner: z.boolean().optional(),
  proMode: z.boolean().optional(),
  kind: z.enum(["question", "sales-deep", "super-agent"]).optional(),
}).strict();

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Swarm.", 409, correlationId);
    const conversationId = new URL(request.url).searchParams.get("conversationId");
    const panel = conversationId && /^[0-9A-HJKMNP-TV-Z]{26}$/u.test(conversationId)
      ? await loadSwarmForConversation(conversationId)
      : await loadSwarmPanel();
    return Response.json({
      run: panel.run,
      conversationIds: panel.conversationIds,
      concurrency: SWARM_CLIENT_CONCURRENCY,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": correlationId } });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "Swarm is unavailable.",
      status,
      correlationId,
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  let begun: Awaited<ReturnType<typeof beginConversationTurn>> | undefined;
  let turnId = "";
  try {
    assertSameOriginMutation(request);
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Swarm.", 409, correlationId);
    const rateLimit = await consumeAlbertRateLimit("swarm.run");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);

    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const salesDeep = parsed.kind === SALES_DEEP_KIND;
    const superAgent = parsed.kind === SUPER_AGENT_KIND;
    const preferences = salesDeep
      ? SALES_DEEP_PREFERENCES
      : superAgent
        ? SUPER_AGENT_PREFERENCES
      : normalizeAgentPreferences(parsed.preferences);
    const solPlanner = superAgent
      ? SUPER_AGENT_SOL_PLANNER
      : !salesDeep && parsed.solPlanner === true;
    const reasoningMode = superAgent || (!salesDeep && parsed.proMode === true)
      ? "pro" as const
      : "standard" as const;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return jsonError("Swarm is not configured on this environment.", 503, correlationId);

    const [routing, context] = await Promise.all([
      loadConnectorRouting(auth.supabase).catch(() => undefined),
      loadBusinessContext(auth.supabase).catch(() => null),
    ]);
    const connectors = routing?.activeConnectors ?? [];
    if (connectors.length === 0) {
      return jsonError("Connect a data source before starting a swarm.", 409, correlationId);
    }

    const allocation = salesDeep
      ? {
          plan: salesDeepPlan({ timezone: tenant.timezone }),
          source: "fallback" as const,
          periodSource: "fallback" as const,
          issue: null,
        }
      : superAgent
        ? {
            plan: superAgentPlan({ timezone: tenant.timezone }),
            source: "fallback" as const,
            periodSource: "fallback" as const,
            issue: null,
          }
      : await allocateSwarmPlan({
          question: parsed.message,
          connectors,
          businessContextExcerpt: context?.rendered,
          timezone: tenant.timezone,
          apiKey,
          baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
          safetyIdentifier: createHash("sha256")
            .update(`${tenant.tenant_id}:${auth.user.id}`)
            .digest("hex"),
          signal: request.signal,
        });
    const plan = allocation.plan;
    const logPlan = allocation.source === "fallback" ? logger.warn : logger.info;
    logPlan("swarm.plan_allocated", {
      tenantId: tenant.tenant_id,
      source: allocation.source,
      periodSource: allocation.periodSource,
      issue: allocation.issue,
      agentCount: plan.agents.length,
    }, correlationId);
    const agents = salesDeep
      ? prepareSalesDeepAgents(plan, parsed.message)
      : superAgent
        ? prepareSuperAgentPasses(plan, parsed.message)
      : prepareSwarmAgents(plan, parsed.message);

    turnId = ulid();
    const runtimeProfile = {
      provider: "openai",
      runtime: ALBERT_CODEX_RUNTIME,
      analyticalRuntime: ALBERT_CODEX_ANALYTICAL_RUNTIME,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
      reasoningMode,
      fastMode: preferences.fastMode,
      solPlanner,
      codexCliVersion: ALBERT_CODEX_PINNED_CLI_VERSION,
      codexProtocolVersion: ALBERT_CODEX_PROTOCOL_VERSION,
      analysisTimeoutMs: ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
      swarm: true,
      ...(superAgent ? { superAgent: true, superAgentDurationMs: SUPER_AGENT_DURATION_MS } : {}),
    } as const;

    begun = await beginConversationTurn({
      conversationId: parsed.conversationId,
      turnId,
      message: parsed.message,
      runtimeProfile,
      replaceTurnId: parsed.replaceTurnId,
      staleLeaseFailureCode: "albert_swarm_stale_lease_released",
      supabase: auth.supabase,
    });
    const conversationId = begun.conversationId;
    const runId = ulid();
    const run = await beginSwarmRun({
      runId,
      parentConversationId: conversationId,
      parentTurnId: turnId,
      question: parsed.message,
      model: preferences.model,
      reasoningEffort: preferences.reasoningEffort,
      plan: {
        periodLabel: plan.periodLabel,
        rationale: plan.rationale,
        period: plan.period,
        source: allocation.source,
        periodSource: allocation.periodSource,
        issue: allocation.issue,
        fastMode: preferences.fastMode,
        solPlanner,
        reasoningMode,
        ...(salesDeep ? { kind: SALES_DEEP_KIND } : {}),
        ...(superAgent ? {
          kind: SUPER_AGENT_KIND,
          durationMs: SUPER_AGENT_DURATION_MS,
          checkpointIntervalMs: SUPER_AGENT_CHECKPOINT_INTERVAL_MS,
        } : {}),
      },
      agents: agents.map((agent) => ({
        key: agent.key,
        title: agent.title,
        tagline: agent.tagline,
        role: agent.role,
        assignment: agent.assignment,
        exclude: agent.exclude,
        prompt: agent.prompt,
      })),
    });

    const occurredAt = new Date().toISOString();
    await appendConversationEvent({
      conversationId,
      turnId,
      supabase: auth.supabase,
      event: {
        id: ulid(),
        sequence: 1,
        occurredAt,
        type: "narrative",
        purpose: "acknowledgement",
        text: salesDeep
          ? `I'll run a deep sales swarm across ${agents.length} specialists. This can take a while. I'll write what they find into a sales briefing you can ask about.`
          : superAgent
            ? `I'll run this as a Super agent investigation: ${agents.length} ordered deep passes, one at a time, with a 45-minute hard budget and a public progress checkpoint every two minutes.`
          : `I'll split this across ${agents.length} specialists, then combine what they find.`,
      },
    }).catch(() => undefined);
    await appendConversationEvent({
      conversationId,
      turnId,
      supabase: auth.supabase,
      event: {
        id: ulid(),
        sequence: 2,
        occurredAt: new Date().toISOString(),
        type: "plan",
        steps: swarmPlanSteps({
          agents: agents.map((agent) => ({ key: agent.key, title: agent.title, status: "pending" })),
        }),
      },
    }).catch(() => undefined);

    if (await conversationNeedsTitle(conversationId, auth.supabase).catch(() => false)) {
      void generateConversationTitle({
        question: parsed.message,
        apiKey,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      }).then((title) => {
        if (!title) return;
        return assignConversationTitle({ conversationId, title, supabase: auth.supabase });
      }).catch(() => undefined);
    }

    logger.info("swarm.run_started", {
      tenantId: tenant.tenant_id,
      runId,
      conversationId,
      turnId,
      agentCount: agents.length,
      model: preferences.model,
    }, correlationId);

    return Response.json({
      run,
      agents: agents.map((agent) => ({
        key: agent.key,
        title: agent.title,
        tagline: agent.tagline,
        role: agent.role,
        prompt: agent.prompt,
      })),
      preferences: {
        model: preferences.model,
        reasoningEffort: preferences.reasoningEffort,
        fastMode: preferences.fastMode,
        solPlanner,
        // Pro is deliberately reserved for the one evidence-only parent
        // synthesis. Tool-using workers stay standard so they can finish
        // governed evidence inside the interactive route window.
        proMode: false,
      },
      synthesisProMode: superAgent ? SUPER_AGENT_PRO_MODE : reasoningMode === "pro",
      concurrency: superAgent ? SUPER_AGENT_CONCURRENCY : SWARM_CLIENT_CONCURRENCY,
      kind: superAgent ? SUPER_AGENT_KIND : salesDeep ? SALES_DEEP_KIND : "question",
      ...(superAgent ? {
        durationMs: SUPER_AGENT_DURATION_MS,
        checkpointIntervalMs: SUPER_AGENT_CHECKPOINT_INTERVAL_MS,
      } : {}),
      conversationId,
      turnId,
    }, {
      headers: {
        "Cache-Control": "no-store",
        "x-request-id": correlationId,
        "X-Albert-Runtime": "codex",
        "X-Albert-Conversation-Id": conversationId,
        "X-Albert-Turn-Id": turnId,
      },
    });
  } catch (error) {
    if (begun && turnId) {
      await failConversationTurn({
        conversationId: begun.conversationId,
        turnId,
        failureCode: "albert_swarm_start_failed",
        supabase: (await requireUser()).supabase,
      }).catch(() => undefined);
    }
    if (error instanceof z.ZodError) return jsonError("Invalid swarm request.", 400, correlationId);
    logger.error("swarm.run_start_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The swarm could not be started.",
      status,
      correlationId,
    );
  }
}
