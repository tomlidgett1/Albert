/**
 * Proactive control panel state (ADR 0113).
 *
 * GET → the latest research run with its findings (each enriched with the
 * roster prompt so an interrupted run can resume), the roster available to
 * this tenant's connectors, whether the caller may start a run, and the
 * proactive conversation ids the dash shell hides from sidebar history.
 */
import {
  PROACTIVE_CLIENT_CONCURRENCY,
  PROACTIVE_MODEL,
  PROACTIVE_REASONING_EFFORT,
  proactiveAgentByKey,
  rosterForConnectors,
} from "@/services/proactive/src/roster";
import { loadProactivePanel } from "@/services/control-plane/src/proactive-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  loadConnectorRouting,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import { correlationIdFromHeader } from "@/packages/observability/src";

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlationIdFromHeader(request.headers.get("x-request-id"));
  try {
    const { supabase } = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) {
      return Response.json({ error: "Create your organisation before using Proactive." }, {
        status: 409,
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    const [panel, routing] = await Promise.all([
      loadProactivePanel(),
      loadConnectorRouting(supabase).catch(() => undefined),
    ]);
    const activeConnectors = routing?.activeConnectors ?? [];
    const availableAgents = rosterForConnectors(activeConnectors).map((agent) => ({
      key: agent.key,
      title: agent.title,
      tagline: agent.tagline,
    }));
    const run = panel.run === null ? null : {
      ...panel.run,
      findings: panel.run.findings.map((finding) => ({
        ...finding,
        prompt: proactiveAgentByKey(finding.agentKey)?.prompt ?? null,
      })),
    };
    return Response.json({
      run,
      conversationIds: panel.conversationIds,
      availableAgents,
      activeConnectors,
      canRun: tenant.role === "owner" || tenant.role === "manager",
      model: PROACTIVE_MODEL,
      reasoningEffort: PROACTIVE_REASONING_EFFORT,
      concurrency: PROACTIVE_CLIENT_CONCURRENCY,
      timezone: tenant.timezone,
    }, { headers: { "Cache-Control": "no-store", "x-request-id": correlationId } });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Proactive research is unavailable.";
    return Response.json({ error: message }, {
      status,
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  }
}
