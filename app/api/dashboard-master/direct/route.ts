/**
 * Advance a Dashboard Master session between rounds: once the current round's
 * objectives are all recorded, the director model assigns the next round's
 * drill/challenge objectives (or moves the session to compose). Returns the
 * new worker turns for the browser to execute.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { dashboardSessionStateSchema } from "@/services/dashboard-master/src/contracts";
import {
  dashboardWorkerPrompt,
  directDashboardPhase,
  pendingDashboardObjectives,
} from "@/services/dashboard-master/src/session";
import { createDashboardDirector } from "@/services/dashboard-master/src/compose";
import {
  loadDashboardMasterPanel,
  saveDashboardMasterState,
} from "@/services/control-plane/src/dashboard-master-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  readBoundedJsonBody,
} from "@/services/control-plane/src/request-security";
import { correlationIdFromHeader, createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

export const maxDuration = 180;

const logger = createServiceLogger("albert-dashboard-master-web");

const bodySchema = z.object({
  reportId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
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
    const auth = await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) return jsonError("Create your organisation before using the dashboard.", 409, correlationId);
    if (tenant.role !== "owner" && tenant.role !== "manager") {
      return jsonError("Only owners and managers can refresh the dashboard.", 403, correlationId);
    }
    const parsed = bodySchema.parse(await readBoundedJsonBody(request));
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) return jsonError("The dashboard is not configured on this environment.", 503, correlationId);

    const panel = await loadDashboardMasterPanel();
    if (!panel.running || panel.running.reportId !== parsed.reportId) {
      return jsonError("That dashboard session is no longer running.", 409, correlationId);
    }
    const state = dashboardSessionStateSchema.parse(panel.running.sessionState ?? {});
    if (pendingDashboardObjectives(state).length > 0) {
      return jsonError("The current round still has objectives in flight.", 409, correlationId);
    }
    const director = createDashboardDirector({
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      safetyIdentifier: createHash("sha256")
        .update(`${tenant.tenant_id}:${auth.user.id}`)
        .digest("hex"),
    });
    const directed = dashboardSessionStateSchema.parse(
      await directDashboardPhase(state, director, state.periodLabel),
    );
    await saveDashboardMasterState({ reportId: parsed.reportId, state: directed });
    logger.info("dashboard_master.session_directed", {
      tenantId: tenant.tenant_id,
      reportId: parsed.reportId,
      phase: directed.phase,
      objectives: directed.objectives.length,
    }, correlationId);
    return Response.json({
      state: directed,
      turns: pendingDashboardObjectives(directed).map((objective) => ({
        key: objective.key,
        round: objective.round,
        title: objective.title,
        message: dashboardWorkerPrompt(objective, directed.periodLabel),
      })),
    }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid dashboard direction request.", 400, correlationId);
    logger.error("dashboard_master.direct_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard session could not be advanced.",
      status,
      correlationId,
    );
  }
}
