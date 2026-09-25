/**
 * Record one Dashboard Master worker's outcome. The browser executed the
 * omni turn and captured its governed evidence; the server re-distils the
 * answer, rebuilds the finding against the stored objective (never trusting
 * client-side titling), and folds it into the durable session state.
 */
import { z } from "zod";
import {
  dashboardEvidenceChartSchema,
  dashboardEvidenceTableSchema,
  dashboardSessionStateSchema,
} from "@/services/dashboard-master/src/contracts";
import { buildDashboardFinding } from "@/services/dashboard-master/src/session";
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

const logger = createServiceLogger("albert-dashboard-master-web");

const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const bodySchema = z.object({
  reportId: ulidSchema,
  key: z.string().regex(/^[a-z][a-z0-9-]{2,60}$/),
  answerState: z.string().max(40).nullable(),
  answer: z.string().max(120_000),
  tables: z.array(dashboardEvidenceTableSchema).max(3).default([]),
  charts: z.array(dashboardEvidenceChartSchema).max(2).default([]),
  queries: z.number().int().min(0).max(200),
  durationMs: z.number().int().min(0).max(2 * 60 * 60_000),
  failed: z.boolean(),
  conversationId: ulidSchema.optional(),
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
    const parsed = bodySchema.parse(await readBoundedJsonBody(request, 4 * 1024 * 1024));

    const panel = await loadDashboardMasterPanel();
    if (!panel.running || panel.running.reportId !== parsed.reportId) {
      return jsonError("That dashboard session is no longer running.", 409, correlationId);
    }
    const state = dashboardSessionStateSchema.parse(panel.running.sessionState ?? {});
    const objective = state.objectives.find((entry) => entry.key === parsed.key);
    if (!objective) return jsonError("Unknown dashboard objective.", 400, correlationId);
    if (state.completedKeys.includes(parsed.key)) {
      return Response.json({ state }, {
        headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
      });
    }
    const finding = buildDashboardFinding({
      objective,
      evidence: {
        tables: [...parsed.tables],
        charts: [...parsed.charts],
        queries: parsed.queries,
        answer: parsed.answer,
        answerState: parsed.answerState,
      },
      durationMs: parsed.durationMs,
      failed: parsed.failed,
    });
    const nextState = dashboardSessionStateSchema.parse({
      ...state,
      findings: [...state.findings, finding],
      completedKeys: [...state.completedKeys, objective.key],
      investigationMs: state.investigationMs + finding.durationMs,
      conversationIds: parsed.conversationId && !state.conversationIds.includes(parsed.conversationId)
        ? [...state.conversationIds, parsed.conversationId].slice(-48)
        : state.conversationIds,
    });
    await saveDashboardMasterState({ reportId: parsed.reportId, state: nextState });
    logger.info("dashboard_master.finding_recorded", {
      tenantId: tenant.tenant_id,
      reportId: parsed.reportId,
      key: objective.key,
      failed: finding.failed,
    }, correlationId);
    return Response.json({ state: nextState }, {
      headers: { "Cache-Control": "no-store", "x-request-id": correlationId },
    });
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("Invalid dashboard finding request.", 400, correlationId);
    logger.error("dashboard_master.finding_failed", safeErrorEvidence(error), correlationId);
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return jsonError(
      error instanceof ControlPlaneError ? error.message : "The dashboard finding could not be saved.",
      status,
      correlationId,
    );
  }
}
