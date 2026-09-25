/**
 * Begin a Dashboard Master deep-dive session. Owner/manager, rate-limited.
 * Registers the session row with its round-1 breadth objectives and returns
 * the worker turns for the browser to execute through /api/omni-conversation
 * — the same browser-orchestrated shape as Proactive and Swarm runs.
 */
import { z } from "zod";
import { ulid } from "ulid";
import {
  DASHBOARD_MASTER_EFFORT,
  DASHBOARD_MASTER_MODEL,
  DASHBOARD_MASTER_PERIOD_LABEL,
  dashboardSessionStateSchema,
} from "@/services/dashboard-master/src/contracts";
import {
  dashboardWorkerPrompt,
  directDashboardPhase,
  newDashboardSessionState,
  pendingDashboardObjectives,
} from "@/services/dashboard-master/src/session";
import { beginDashboardMasterSession } from "@/services/control-plane/src/dashboard-master-repository";
import {
  ControlPlaneError,
  consumeAlbertRateLimit,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

const logger = createServiceLogger("albert-dashboard-master-web");

const bodySchema = z.object({
  budgetMinutes: z.number().int().min(10).max(120).optional(),
}).strict();

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
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using the dashboard.", 409, correlationId);
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return jsonError("Only owners and managers can refresh the dashboard.", 403, correlationId);
    }
    const rateLimit = await consumeAlbertRateLimit("dashboard_master.refresh");
    if (!rateLimit.allowed) {
      return jsonError("The dashboard has been refreshed enough for today; try again later.", 429, correlationId);
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));

    const reportId = ulid();
    const periodLabel = DASHBOARD_MASTER_PERIOD_LABEL;
    const planned = await directDashboardPhase(
      { ...newDashboardSessionState(parsed.budgetMinutes ? parsed.budgetMinutes * 60_000 : undefined), periodLabel },
      async () => [],
      periodLabel,
    );
    const state = dashboardSessionStateSchema.parse(planned);
    await beginDashboardMasterSession({
      reportId,
      model: DASHBOARD_MASTER_MODEL,
      reasoningEffort: DASHBOARD_MASTER_EFFORT,
      state,
    });
    logger.info("dashboard_master.session_begun", {
      tenantId: tenant.tenant_id,
      reportId,
      objectives: state.objectives.length,
    }, correlationId);
    return Response.json({
      reportId,
      state,
      turns: pendingDashboardObjectives(state).map((objective) => ({
        key: objective.key,
        round: objective.round,
        title: objective.title,
        message: dashboardWorkerPrompt(objective, periodLabel),
      })),
    }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid dashboard refresh request.", 400, correlationId);
    logger.error("dashboard_master.session_begin_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard refresh could not be started.",
      status,
      correlationId,
    );
  }
}
