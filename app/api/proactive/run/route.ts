/**
 * Start a Proactive research run (ADR 0113).
 *
 * POST → resolves the roster against the tenant's active connectors, records
 * the run and its pending findings, and returns the agents (with prompts) for
 * the browser to fan out through /api/codex-conversation with bounded
 * concurrency. Owner/manager only; rate limited by the proactive.run policy.
 */
import { ulid } from "ulid";
import {
  PROACTIVE_CLIENT_CONCURRENCY,
  PROACTIVE_FAST_MODE,
  PROACTIVE_MODEL,
  PROACTIVE_REASONING_EFFORT,
  rosterForConnectors,
} from "@/services/proactive/src/roster";
import { beginProactiveRun } from "@/services/control-plane/src/proactive-repository";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-proactive-web");

function jsonError(message: string, status: number, correlationId: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
  });
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    assertSameOriginMutation(request);
    const { supabase } = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using Proactive.", 409, correlationId);
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return jsonError("Only owners and managers can start proactive research.", 403, correlationId);
    }
    const rateLimit = await consumeAlbertRateLimit("proactive.run");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);

    const routing = await loadConnectorRouting(supabase).catch(() => undefined);
    const activeConnectors = routing?.activeConnectors ?? [];
    const roster = rosterForConnectors(activeConnectors);
    if (roster.length === 0) {
      return jsonError("Connect a data source before starting proactive research.", 409, correlationId);
    }

    const runId = ulid();
    const run = await beginProactiveRun({
      runId,
      model: PROACTIVE_MODEL,
      reasoningEffort: PROACTIVE_REASONING_EFFORT,
      agents: roster.map((agent) => ({
        key: agent.key,
        title: agent.title,
        tagline: agent.tagline,
      })),
    });
    logger.info("proactive.run_started", {
      tenantId: tenant.tenant_id,
      runId,
      agentCount: roster.length,
      model: PROACTIVE_MODEL,
    }, correlationId);
    return Response.json({
      run,
      agents: roster.map((agent) => ({
        key: agent.key,
        title: agent.title,
        tagline: agent.tagline,
        prompt: agent.prompt,
      })),
      preferences: {
        model: PROACTIVE_MODEL,
        reasoningEffort: PROACTIVE_REASONING_EFFORT,
        fastMode: PROACTIVE_FAST_MODE,
      },
      concurrency: PROACTIVE_CLIENT_CONCURRENCY,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": correlationId } });
  } catch (error) {
    logger.error("proactive.run_start_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Proactive research could not be started.";
    return jsonError(message, status, correlationId);
  }
}
